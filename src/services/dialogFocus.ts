import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const isFocusable = (element: HTMLElement) => {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

export const focusFirstDialogControl = (dialog: HTMLElement | null) => {
  if (!dialog) return;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(isFocusable);
  (controls[0] || dialog).focus();
};

export const trapDialogFocus = (
  event: ReactKeyboardEvent<HTMLElement>,
  dialogRef: RefObject<HTMLElement | null>
) => {
  if (event.key !== 'Tab') return;
  const dialog = dialogRef.current;
  if (!dialog) return;

  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(isFocusable);
  if (controls.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
};
