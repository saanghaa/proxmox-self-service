import type { Request } from "express";

function firstForwardedIp(raw: string): string {
  const first = raw.split(",")[0]?.trim() || "";
  return first.replace(/^\[|\]$/g, "");
}

export function getClientIp(req: Request): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) return cfIp.trim();

  const xOriginalForwardedFor = req.headers["x-original-forwarded-for"];
  if (typeof xOriginalForwardedFor === "string" && xOriginalForwardedFor.trim()) {
    return firstForwardedIp(xOriginalForwardedFor);
  }
  if (Array.isArray(xOriginalForwardedFor) && xOriginalForwardedFor.length > 0 && xOriginalForwardedFor[0]) {
    return firstForwardedIp(String(xOriginalForwardedFor[0]));
  }

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return firstForwardedIp(xff);
  if (Array.isArray(xff) && xff.length > 0 && xff[0]) return firstForwardedIp(String(xff[0]));

  const xrip = req.headers["x-real-ip"];
  if (typeof xrip === "string" && xrip.trim()) return xrip.trim();

  return req.ip || "";
}
