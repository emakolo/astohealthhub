// Mission file (simulated) — loaded before app.js. Swap this file to change crew/ship.
// Threshold values are the team's existing design rules, copied as-is (not NASA figures).

const MISSION = {
  name: "Mars transit",
  day: 142,
  // Ship layout: pod display names (crew.pod must match one of these)
  pods: ["Lab", "Pod 2", "Pod 3", "Cockpit"],
  // Who the "Ortega's rough night" demo targets (must match a crew id)
  demoCrewId: "ortega",
  // Mission-approved thresholds — same numbers as the original evaluate() rules
  thresholds: {
    hr: { alertHigh: 110, alertDev: 15, alertLow: 45, watchHigh: 100, watchDev: 10, watchLow: 50 },
    spo2: { alert: 92, watch: 95 },
    bp: { alertSys: 160, alertDia: 100, watchSys: 140, watchDia: 90 },
    temp: { alertHigh: 38.5, alertLow: 35.5, watchHigh: 37.5, watchLow: 36.5 },
    sleep: { alert: 5, alertTwo: 6, watch: 7 },
    stress: { alert: 5, alertTwo: 4, watch: 4 },
    ex: { alert: 15, watch: 30, target: 60 },
    rad: { alert: 90, watch: 70 },
    trend: { hrRise: 5 },
    emergency: { spo2: 90, temp: 39 },
    cabin: { co2Station: 1500 },
  },
  crew: [
    {
      id: "chen", name: "Cmdr. Maya Chen", role: "Commander", pod: "Lab",
      isBackupMedic: true, rad: 48,
      baselines: { restingHR: 62, spo2: 98, sleepHours: 7.5 },
      wearables: { wristband: "WB-1042", vest: "VS-2210" },
      hist: { sleep: [7.6, 7.4, 7.5, 7.7, 7.3, 7.5, 7.4], hr: [62, 61, 63, 62, 62, 61, 62], stress: [2, 2, 1, 2, 2, 2, 2], ex: [62, 58, 65, 60, 55, 60, 58] },
    },
    {
      id: "ortega", name: "Dr. Luis Ortega", role: "Crew medic / science", pod: "Pod 2",
      isBackupMedic: false, rad: 52,
      baselines: { restingHR: 68, spo2: 97, sleepHours: 7.4 },
      wearables: { wristband: "WB-1043", vest: "VS-2211" },
      hist: { sleep: [7.5, 7.3, 7.4, 7.6, 7.4, 7.5, 7.4], hr: [68, 67, 68, 69, 68, 68, 68], stress: [2, 2, 2, 3, 2, 2, 2], ex: [58, 60, 55, 62, 57, 59, 56] },
      histDemo: { sleep: [7.4, 7.2, 6.6, 6.1, 5.6, 5.3, 5.1], hr: [68, 68, 69, 71, 73, 76, 79], stress: [2, 2, 3, 3, 4, 4, 4], ex: [55, 48, 40, 32, 25, 18, 12] },
    },
    {
      id: "bello", name: "Aisha Bello", role: "Engineer", pod: "Pod 3",
      isBackupMedic: false, rad: 62,
      baselines: { restingHR: 65, spo2: 98, sleepHours: 7.0 },
      wearables: { wristband: "WB-1044", vest: "VS-2212" },
      hist: { sleep: [7.0, 6.9, 7.1, 7.0, 7.2, 7.0, 7.0], hr: [65, 65, 64, 66, 65, 65, 65], stress: [2, 3, 2, 2, 3, 2, 2], ex: [50, 48, 52, 45, 55, 42, 48] },
    },
    {
      id: "kowalski", name: "Tom Kowalski", role: "Pilot", pod: "Cockpit",
      isBackupMedic: false, rad: 41,
      baselines: { restingHR: 58, spo2: 99, sleepHours: 7.7 },
      wearables: { wristband: "WB-1045", vest: "VS-2213" },
      hist: { sleep: [7.8, 7.6, 7.9, 7.7, 7.8, 7.6, 7.7], hr: [58, 57, 58, 59, 58, 58, 58], stress: [1, 2, 1, 1, 2, 1, 1], ex: [70, 68, 72, 65, 70, 68, 66] },
    },
  ],
};
