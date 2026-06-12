export type CopyTextResult = {
  ok: boolean;
  method: 'clipboard' | 'execCommand' | 'manual';
  error?: string;
};

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error || '');
};

export const copyText = async (text: string): Promise<CopyTextResult> => {
  if (!text) return { ok: false, method: 'manual', error: 'empty text' };

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Continue to the legacy fallback below. Some mobile WebViews expose the
      // Clipboard API but reject writes outside a fully trusted context.
    }
  }

  if (typeof document === 'undefined') {
    return { ok: false, method: 'manual', error: 'document unavailable' };
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.top = '0';
  textArea.style.left = '-9999px';
  textArea.style.width = '1px';
  textArea.style.height = '1px';
  textArea.style.opacity = '0';
  textArea.style.fontSize = '16px';

  const selection = document.getSelection();
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;

  try {
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length);

    const copied = document.execCommand('copy');
    return copied
      ? { ok: true, method: 'execCommand' }
      : { ok: false, method: 'manual', error: 'execCommand returned false' };
  } catch (error) {
    return { ok: false, method: 'manual', error: getErrorMessage(error) };
  } finally {
    textArea.remove();
    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    activeElement?.focus();
  }
};
