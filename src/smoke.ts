import { Session, executeTool } from "./agent/tools.js";

const s = new Session();
console.log("1 book unverified:", executeTool(s, "book_appointment", { doctor_id: "d1", start: "2026-10-01T10:00" }));
console.log("2 wrong DOB:", executeTool(s, "verify_patient", { full_name: "Priya Sharma", date_of_birth: "1990-01-01" }));
console.log("3 verify:", executeTool(s, "verify_patient", { full_name: "Priya Sharma", date_of_birth: "1990-04-12" }));
console.log("4 taken slot:", executeTool(s, "book_appointment", { doctor_id: "d1", start: "2026-09-29T09:00" }));
console.log("5 someone else's appt:", executeTool(s, "cancel_appointment", { appointment_id: "a2" }));
console.log("6 weekend slot:", executeTool(s, "book_appointment", { doctor_id: "d2", start: "2026-10-03T10:00" }));
console.log("7 good booking:", executeTool(s, "book_appointment", { doctor_id: "d2", start: "2026-10-01T10:00" }));