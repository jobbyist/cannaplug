// Wording of the Cannaplug dab hit waiver. One source for the till form and the printed copy.
// The indemnity wording (section 5) should be reviewed by an attorney before it is relied on.

export const WAIVER_TITLE = "Dab Hit Waiver, Health Screening & Indemnity Declaration";

export const WAIVER_INTRO =
  "This form must be read, completed and signed by every customer before taking a dab hit (an inhaled dose of concentrated cannabis extract) at Cannaplug. Please answer every question honestly and completely. The information is used to protect your safety.";

export const WAIVER_ABOUT_INTRO =
  'A "dab" is an inhaled dose of a concentrated cannabis extract (wax, shatter, budder or similar), heated to a high temperature and inhaled using a rig, nail or banger. Dabs are significantly more potent than smoking cannabis flower, and their effects are typically stronger, faster-acting and less predictable.';

export const WAIVER_RISKS = [
  "Coughing fits",
  "Dizziness or light-headedness",
  "Fainting or temporary loss of consciousness",
  "Rapid or irregular heartbeat",
  "Nausea or vomiting",
  "Anxiety, paranoia or disorientation",
  "Burns from hot dabbing equipment (rig, nail/banger, torch)",
  "Intensified or unpredictable effects when combined with alcohol, drugs, medication, or on an empty stomach",
];

export const WAIVER_CLAUSES: [string, string][] = [
  [
    "5.1",
    "I have read and understood Section 4 above, and I voluntarily choose to take a dab hit at Cannaplug.",
  ],
  [
    "5.2",
    "I confirm that I am 18 years of age or older and legally permitted to consume cannabis products.",
  ],
  [
    "5.3",
    "All information I have provided in this form is true, accurate and complete to the best of my knowledge, and I have not withheld any information relevant to my safety.",
  ],
  [
    "5.4",
    "I understand that cannabis concentrates are significantly more potent than cannabis flower and that effects vary from person to person.",
  ],
  [
    "5.5",
    "I acknowledge that Cannaplug, its owners, management and staff have not pressured, encouraged or medically cleared me to consume, and that my decision to take a dab hit is made voluntarily, of my own free will, and at my own risk.",
  ],
  [
    "5.6",
    "To the fullest extent permitted by law, I release, indemnify and hold harmless Cannaplug, its owners, directors, management, employees and agents from any and all claims, liability, loss, injury or damage, including but not limited to fainting, falls, burns, or any other medical event, arising from or connected to my consumption of cannabis concentrate on these premises, save where caused by the gross negligence or wilful misconduct of Cannaplug or its staff.",
  ],
  [
    "5.7",
    "I understand that Cannaplug staff may, at their reasonable discretion, refuse to serve me or may stop the activity at any time if they believe it is unsafe for me to continue.",
  ],
  [
    "5.8",
    "I understand that if I feel unwell, faint, or an emergency occurs, Cannaplug staff will render reasonable first-aid assistance and/or contact emergency services and/or my emergency contact, but that this does not constitute medical advice or treatment, and that Cannaplug is not a medical facility.",
  ],
  [
    "5.9",
    "I confirm that I have had the opportunity to ask questions, that I am not signing this form under duress, and that I understand signing this form does not replace professional medical advice.",
  ],
];

export const WAIVER_POPIA =
  "I consent to Cannaplug processing the personal and health information on this form for my safety and to keep a record of this visit. It is read only by managers and deleted after 3 years (POPIA).";

export const WAIVER_FOOTER =
  "This waiver is a risk-management document and does not replace professional medical advice.";

export const CONDITIONS: { id: string; label: string }[] = [
  { id: "asthma", label: "Asthma or other respiratory / lung condition" },
  { id: "heart", label: "Heart or cardiovascular condition" },
  { id: "epilepsy", label: "Epilepsy / seizure disorder" },
  { id: "low_bp", label: "Low blood pressure or history of fainting" },
  { id: "anxiety", label: "Anxiety / panic disorder" },
  { id: "pregnant", label: "Pregnant or breastfeeding" },
  { id: "other", label: "Other" },
];

export const conditionLabel = (id: string) => CONDITIONS.find((c) => c.id === id)?.label ?? id;

export const DECLINE_LABEL: Record<string, string> = {
  under_18: "Under 18",
  under_the_influence: "Customer says they are under the influence",
  pregnant_or_breastfeeding: "Pregnant or breastfeeding",
  staff_concern: "Staff noted signs of intoxication or concern",
};

export const declineLabel = (r: string) => DECLINE_LABEL[r] ?? r;
