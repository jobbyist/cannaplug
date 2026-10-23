// Prints a fresh VAPID key pair for web push. Put both in Vercel (Production) and keep the private key secret:
//   bun scripts/gen-vapid.ts
// Changing the keys later invalidates every saved device (members re-enable push once).
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("VAPID_SUBJECT=mailto:info@cannaplug012.co.za");
