/** Marks a staff purchase (the staff rate was applied). Small, gold, and readable in light and dark. */
export function StaffBadge({ className = "" }: { className?: string }) {
  return (
    <span
      data-testid="staff-badge"
      title="Staff purchase: the staff rate was applied"
      className={`inline-flex items-center rounded-full border border-gold/60 bg-gold/20 px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-wide text-[#0B3D20] dark:text-gold ${className}`}
    >
      Staff
    </span>
  );
}
