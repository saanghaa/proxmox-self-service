declare module "@otplib/v12-adapter" {
  interface AuthenticatorOptions {
    window?: number;
    step?: number;
    digits?: number;
    algorithm?: string;
  }

  interface Authenticator {
    generateSecret(): string;
    keyuri(user: string, service: string, secret: string): string;
    verify(opts: { token: string; secret: string }): boolean;
    check(token: string, secret: string): boolean;
    options: AuthenticatorOptions;
  }

  export const authenticator: Authenticator;
}
