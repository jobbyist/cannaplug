import type { RequestStatus } from "@/lib/clinical/documents-data.server";

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  REQUESTED: "Waiting to be assigned",
  ASSIGNED: "With your practitioner",
  IN_PROGRESS: "Being prepared",
  FULFILLED: "Completed",
  DECLINED: "Not going ahead",
  CANCELLED: "Cancelled",
};
