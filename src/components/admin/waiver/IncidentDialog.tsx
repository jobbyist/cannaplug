import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recordWaiverIncidentFn } from "@/lib/waiver.functions";

/** Records what happened if a customer had a problem after a dab hit (waiver section 7). */
export function IncidentDialog({
  waiverId,
  customerName,
  open,
  onOpenChange,
  onSaved,
}: {
  waiverId: string;
  customerName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: () => void;
}) {
  const [text, setText] = useState("");
  const [services, setServices] = useState(false);
  const [contact, setContact] = useState(false);
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await recordWaiverIncidentFn({
        data: {
          waiverId,
          text: text.trim(),
          emergencyServices: services,
          emergencyContact: contact,
          time: time.trim() || null,
          notes: notes.trim() || null,
        },
      });
      setText("");
      setServices(false);
      setContact(false);
      setTime("");
      setNotes("");
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the incident.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="incident-dialog">
        <DialogHeader>
          <DialogTitle>Record an incident</DialogTitle>
          <DialogDescription>For {customerName}. Briefly record what happened.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="i-text">What happened</Label>
            <Input
              id="i-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={1000}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={services} onCheckedChange={(v) => setServices(v === true)} />
            Emergency services contacted
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={contact} onCheckedChange={(v) => setContact(v === true)} />
            Emergency contact notified
          </label>
          <div>
            <Label htmlFor="i-time">Time</Label>
            <Input
              id="i-time"
              placeholder="e.g. 18:45"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              maxLength={20}
            />
          </div>
          <div>
            <Label htmlFor="i-notes">Additional notes</Label>
            <Input
              id="i-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            onClick={() => void save()}
            disabled={busy || text.trim().length < 3}
            className="w-full"
          >
            {busy ? "Saving…" : "Save incident"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
