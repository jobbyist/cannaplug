import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Responsible-use notice. Wording is registered in compliance/copy-register.json (C-11). */
export function ResponsibleConsumptionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Responsible consumption</DialogTitle>
          <DialogDescription>
            Please read this before you order or use any CannaPlug product. It follows the
            requirements of South African law and SAHPRA.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2 text-sm leading-relaxed">
          <li>
            <b>Adults only.</b> Products are for people aged 18 and over. We may ask for ID and we
            do not supply minors.
          </li>
          <li>
            <b>Use only as permitted.</b> Possess and use cannabis only as permitted by South
            African law and any SAHPRA requirement that applies to you.
          </li>
          <li>
            <b>Speak to your healthcare practitioner</b> before you start, especially if you take
            other medicine, are pregnant or breastfeeding, or have a heart, lung or mental-health
            condition.
          </li>
          <li>
            <b>Start low, go slow.</b> Begin with a small amount and wait before taking more.
            Effects differ from person to person and can last for hours.
          </li>
          <li>
            <b>Do not drive</b> or operate machinery while you are under the influence of cannabis.
          </li>
          <li>
            <b>Keep products secure</b> and out of reach of children and pets, in their original
            packaging.
          </li>
          <li>
            <b>Never share or resell</b> products. Do not mix cannabis with alcohol.
          </li>
          <li>
            If you feel unwell, stop and seek medical help. In an emergency call 112 or go to your
            nearest hospital.
          </li>
        </ul>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            I understand
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
