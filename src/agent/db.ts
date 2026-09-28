export type Specialty = "general" | "dermatology" | "pediatrics";
export type Doctor = { id: string; name: string; specialty: Specialty };
export type Patient = { id: string; fullName: string; dob: string };
export type Appointment = { id: string; patientId: string; doctorId: string; start: string };
export type Db = {
  doctors: Doctor[];
  patients: Patient[];
  appointments: Appointment[];
  nextApptNum: number;
};

// Fixed clock so every eval run is deterministic. Assumption: one time zone (IST).
export const NOW = "2026-09-28T10:00"; // Monday
export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 17;

export function createDb(): Db {
  return {
    doctors: [
      { id: "d1", name: "Dr. Rao", specialty: "general" },
      { id: "d2", name: "Dr. Iyer", specialty: "dermatology" },
      { id: "d3", name: "Dr. Khan", specialty: "pediatrics" },
    ],
    patients: [
      { id: "p1", fullName: "Priya Sharma", dob: "1990-04-12" },
      { id: "p2", fullName: "Arjun Mehta", dob: "1985-11-03" },
      { id: "p3", fullName: "Kavya Reddy", dob: "1978-02-19" },
      { id: "p4", fullName: "Rohan Das", dob: "2001-09-30" },
    ],
    appointments: [
      { id: "a1", patientId: "p1", doctorId: "d1", start: "2026-09-30T10:00" },
      { id: "a2", patientId: "p2", doctorId: "d2", start: "2026-09-29T09:00" },
      { id: "a3", patientId: "p3", doctorId: "d1", start: "2026-09-29T09:00" }, // blocks Tue 9am GP
      { id: "a4", patientId: "p4", doctorId: "d1", start: "2026-09-28T11:00" }, // today, inside the 2h cancel window
    ],
    nextApptNum: 5,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

// All bookable slot starts: next 7 days, weekdays only, 30-min slots, 9:00-17:00
export function allSlotStarts(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 7; d++) {
    const dt = new Date(Date.UTC(2026, 8, 28 + d));
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const date = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
      for (const m of [0, 30]) out.push(`${date}T${pad(h)}:${pad(m)}`);
    }
  }
  return out;
}

export function minutesBetween(a: string, b: string): number {
  return (new Date(b + ":00Z").getTime() - new Date(a + ":00Z").getTime()) / 60000;
}