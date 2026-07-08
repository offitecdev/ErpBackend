-- Add a manager-only "Sonderabschluss" project state, kept distinct from the
-- regular COMPLETED status so the UI can flag a specially-closed project.
ALTER TABLE `Project`
    MODIFY `status` ENUM('AWAITING_APPROVAL', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'SPECIALLY_CLOSED', 'CANCELLED') NOT NULL DEFAULT 'AWAITING_APPROVAL';
