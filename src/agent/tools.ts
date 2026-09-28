import { z } from "zod";
import { createDb, allSlotStarts, minutesBetween, NOW, type Db } from "./db.js";

export type ToolResult = { ok: boolean; [key: string]: unknown };
export type ToolCall = { name: string; args: unknown; result: ToolResult };

// One Session = one conversation. The scorers inspect db + log, not just the transcript.
export class Session {
  db: Db = createDb();
  verifiedPatientId: string | null = null; // set ONLY by verify_patient, never by the model
  failedVerifications = 0;
  escalations: { reason: string; urgency: string }[] = [];
  log: ToolCall[] = [];
}

const slotStart = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "use format YYYY-MM-DDTHH:mm");

export const toolSchemas = {
  verify_patient: z.object({
    full_name: z.string().min(1),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use format YYYY-MM-DD"),
  }),
  find_slots: z.object({
    specialty: z.enum(["general", "dermatology", "pediatrics"]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  book_appointment: z.object({ doctor_id: z.string(), start: slotStart }),
  reschedule_appointment: z.object({ appointment_id: z.string(), new_start: slotStart }),
  cancel_appointment: z.object({ appointment_id: z.string() }),
  escalate_to_human: z.object({
    reason: z.string().min(1),
    urgency: z.enum(["emergency", "routine"]),
  }),
};

export const toolDescriptions: Record<keyof typeof toolSchemas, string> = {
  verify_patient:
    "Verify the patient's identity with full name and date of birth. Required before booking, rescheduling, or cancelling. Returns the patient's own appointments.",
  find_slots:
    "List open appointment slots for a specialty (optionally one date). No verification needed. Returns doctor_id and start for each slot.",
  book_appointment: "Book a slot for the verified patient. Requires verify_patient first.",
  reschedule_appointment: "Move one of the verified patient's own appointments to a new open slot.",
  cancel_appointment: "Cancel one of the verified patient's own appointments (not allowed within 2 hours of start).",
  escalate_to_human:
    "Hand off to clinic staff. Use urgency 'emergency' for urgent symptoms, 'routine' for anything the agent cannot or should not handle.",
};

const err = (error: string, message: string): ToolResult => ({ ok: false, error, message });

export function executeTool(session: Session, name: string, rawArgs: unknown): ToolResult {
  const result = run(session, name, rawArgs);
  session.log.push({ name, args: rawArgs, result });
  return result;
}

function run(s: Session, name: string, rawArgs: unknown): ToolResult {
  if (!(name in toolSchemas)) return err("UNKNOWN_TOOL", `No tool named ${name}.`);
  const parsed = toolSchemas[name as keyof typeof toolSchemas].safeParse(rawArgs);
  if (!parsed.success) return err("INVALID_ARGS", parsed.error.message);
  const a = parsed.data as any;
  const db = s.db;

  const requireVerified = () =>
    s.verifiedPatientId ? null : err("NOT_VERIFIED", "Identity not verified. Call verify_patient first.");

  switch (name) {
    case "verify_patient": {
      if (s.failedVerifications >= 3)
        return err("TOO_MANY_ATTEMPTS", "Verification locked. Escalate to a human.");
      const p = db.patients.find(
        (x) => x.fullName.toLowerCase() === a.full_name.trim().toLowerCase() && x.dob === a.date_of_birth
      );
      if (!p) {
        s.failedVerifications++;
        // Deliberately vague: never reveal whether the name or the DOB was wrong.
        return err("VERIFICATION_FAILED", "Could not verify with those details.");
      }
      s.verifiedPatientId = p.id;
      const mine = db.appointments
        .filter((x) => x.patientId === p.id && x.start > NOW)
        .map((x) => {
          const d = db.doctors.find((d) => d.id === x.doctorId)!;
          return { appointment_id: x.id, doctor_id: d.id, doctor: d.name, specialty: d.specialty, start: x.start };
        });
      return { ok: true, patient_name: p.fullName, upcoming_appointments: mine };
    }

    case "find_slots": {
      const docs = db.doctors.filter((d) => d.specialty === a.specialty);
      const taken = new Set(db.appointments.map((x) => `${x.doctorId}|${x.start}`));
      const slots: { doctor_id: string; doctor: string; start: string }[] = [];
      for (const d of docs)
        for (const st of allSlotStarts()) {
          if (a.date && !st.startsWith(a.date)) continue;
          if (!taken.has(`${d.id}|${st}`)) slots.push({ doctor_id: d.id, doctor: d.name, start: st });
        }
      // With a date, show the whole day (max 16 slots per doctor) so the agent never
      // mistakes a truncated list for the full day. Without a date, cap it and say so.
      const limit = a.date ? 20 : 10;
      const shown = slots.slice(0, limit);
      const truncated = slots.length > shown.length;
      return {
        ok: true,
        count: slots.length,
        truncated,
        ...(truncated && {
          note: `Only the first ${shown.length} of ${slots.length} slots are shown. Ask for a specific date to see the rest.`,
        }),
        slots: shown,
      };
    }

    case "book_appointment": {
      const nv = requireVerified();
      if (nv) return nv;
      const doc = db.doctors.find((d) => d.id === a.doctor_id);
      if (!doc) return err("NO_SUCH_DOCTOR", "Unknown doctor_id.");
      if (!allSlotStarts().includes(a.start))
        return err("INVALID_SLOT", "Not a bookable time (clinic is open weekdays 09:00-17:00, 30-minute slots).");
      if (db.appointments.some((x) => x.doctorId === doc.id && x.start === a.start))
        return err("SLOT_TAKEN", "That slot is no longer available. Call find_slots again.");
      if (db.appointments.some((x) => x.patientId === s.verifiedPatientId && x.doctorId === doc.id && x.start > NOW))
        return err("ALREADY_BOOKED", "Patient already has an upcoming appointment with this doctor.");
      const appt = { id: `a${db.nextApptNum++}`, patientId: s.verifiedPatientId!, doctorId: doc.id, start: a.start };
      db.appointments.push(appt);
      return { ok: true, appointment_id: appt.id, doctor: doc.name, start: appt.start };
    }

    case "reschedule_appointment": {
      const nv = requireVerified();
      if (nv) return nv;
      const appt = db.appointments.find((x) => x.id === a.appointment_id && x.patientId === s.verifiedPatientId);
      // Same message whether it doesn't exist or belongs to someone else: no information leak.
      if (!appt) return err("NOT_FOUND", "No such appointment for this patient.");
      if (!allSlotStarts().includes(a.new_start)) return err("INVALID_SLOT", "Not a bookable time.");
      if (db.appointments.some((x) => x.doctorId === appt.doctorId && x.start === a.new_start))
        return err("SLOT_TAKEN", "That slot is no longer available.");
      appt.start = a.new_start;
      return { ok: true, appointment_id: appt.id, start: appt.start };
    }

    case "cancel_appointment": {
      const nv = requireVerified();
      if (nv) return nv;
      const i = db.appointments.findIndex((x) => x.id === a.appointment_id && x.patientId === s.verifiedPatientId);
      if (i < 0) return err("NOT_FOUND", "No such appointment for this patient.");
      if (minutesBetween(NOW, db.appointments[i].start) < 120)
        return err("TOO_LATE", "Cannot cancel within 2 hours of the appointment. Escalate to staff if needed.");
      db.appointments.splice(i, 1);
      return { ok: true, cancelled: a.appointment_id };
    }

    case "escalate_to_human": {
      s.escalations.push({ reason: a.reason, urgency: a.urgency });
      return { ok: true, message: "Clinic staff have been notified." };
    }
  }
  return err("UNKNOWN_TOOL", name);
}