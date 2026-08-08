export function ConfirmationBar({
  onConfirm,
}: {
  onConfirm: (approved: boolean) => void;
}) {
  return (
    <div className="confirmation-bar" role="alertdialog" aria-label="Confirmation needed">
      <span className="confirmation-bar__label">⚠ JARVIS needs your confirmation</span>
      <div className="confirmation-bar__actions">
        <button className="confirmation-bar__deny" onClick={() => onConfirm(false)}>
          Deny
        </button>
        <button className="confirmation-bar__approve" onClick={() => onConfirm(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}
