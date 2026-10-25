// Every browser test starts as a visitor who already confirmed they are 18+ (the gate itself is tested in
// src/test/age-gate.test.tsx and e2e/smoke.spec.ts opts back in to see it).
export const ageConfirmed = (baseURL: string) => ({
  cookies: [],
  origins: [
    {
      origin: new URL(baseURL).origin,
      localStorage: [{ name: "cannaplug.age.v1", value: String(Date.now()) }],
    },
  ],
});
