import { getRequest as startGetRequest } from "@tanstack/react-start/server";

/** Thin wrapper so unit tests can replace request access. */
export function getRequest(): Request | undefined {
  try {
    return startGetRequest();
  } catch {
    return undefined;
  }
}
