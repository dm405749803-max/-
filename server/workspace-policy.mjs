// The new copilot preview follows the confirmed V1 manual-decision policy.
// Existing evaluation workspaces retain their historical behaviour.
export const COPILOT_WORKSPACE = 'copilot-preview';
export const requiresSalesConfirmation = workspace => workspace === COPILOT_WORKSPACE;
