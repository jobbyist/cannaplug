// Minimal types for http_ece (web-push's RFC 8188/8291 implementation), used by tests to decrypt pushes.
declare module "http_ece" {
  const ece: {
    decrypt(
      buffer: Buffer,
      params: { version: "aes128gcm"; privateKey: import("node:crypto").ECDH; authSecret: Buffer },
    ): Buffer;
  };
  export default ece;
}
