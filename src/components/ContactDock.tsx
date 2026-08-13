import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Handshake, MessageCircle, ScanLine, Trophy, X } from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { focusFirstDialogControl, trapDialogFocus } from '../services/dialogFocus';

export const ContactDock: React.FC = () => {
  const { language } = useApp();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const closeDrawer = useCallback(() => {
    setIsOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const focusFrame = window.requestAnimationFrame(() => focusFirstDialogControl(dialogRef.current));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeDrawer, isOpen]);

  const translations = {
    open: { zh: '微信联系', en: 'Contact' },
    title: { zh: '联系方式', en: 'Contact' },
    kicker: { zh: '微信咨询', en: 'WeChat' },
    name: { zh: '何先生', en: 'Mr. He' },
    desc: {
      zh: '扫码添加微信，咨询赛事数据、合作与五大联赛分析交流。',
      en: 'Scan to add WeChat for match data, partnership, and Big Five league analysis.'
    },
    scan: { zh: '微信扫一扫添加', en: 'Scan with WeChat' },
    note: { zh: '添加时备注：足球预测', en: 'Add note: Football prediction' },
    close: { zh: '关闭联系方式', en: 'Close contact panel' },
    items: {
      zh: ['赛事数据', '合作咨询', '五大联赛分析'],
      en: ['Match data', 'Partnership', 'Big Five analysis']
    }
  };

  const t = (key: keyof typeof translations) => translations[key][language];
  const contactItems = (t('items') as string[]).map((label, index) => {
    const icons = [Database, Handshake, Trophy];
    return { label, Icon: icons[index] };
  });
  const qrSrc = `${import.meta.env.BASE_URL}contact-qr-code.jpg`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="contact-dock-button contact-entry-button"
        aria-label={t('open') as string}
        aria-expanded={isOpen}
        aria-controls="contact-drawer"
        onClick={() => setIsOpen(true)}
      >
        <MessageCircle size={18} />
        <span>{t('open') as string}</span>
      </button>

      {isOpen && (
        <>
          <div
            className="contact-drawer-backdrop contact-panel-backdrop is-open"
            aria-hidden="true"
            onClick={closeDrawer}
          />

          <aside
            ref={dialogRef}
            id="contact-drawer"
            className="contact-drawer contact-panel is-open"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-drawer-title"
            tabIndex={-1}
            onKeyDown={(event) => trapDialogFocus(event, dialogRef)}
          >
            <div className="contact-drawer-head contact-panel-head">
              <div>
                <span className="contact-drawer-kicker contact-panel-kicker">
                  <ScanLine size={14} />
                  {t('kicker') as string}
                </span>
                <h2 id="contact-drawer-title">{t('title') as string}</h2>
              </div>
              <button
                type="button"
                className="contact-drawer-close contact-panel-close"
                aria-label={t('close') as string}
                onClick={closeDrawer}
              >
                <X size={18} />
              </button>
            </div>

            <div className="contact-drawer-body contact-panel-body">
              <div className="contact-drawer-qr contact-panel-qr">
                <img src={qrSrc} alt={t('scan') as string} loading="lazy" />
              </div>
              <div className="contact-drawer-copy contact-panel-copy">
                <strong>{language === 'zh' ? `微信：${t('name') as string}` : `WeChat: ${t('name') as string}`}</strong>
                <p>{t('desc') as string}</p>
              </div>
              <div className="contact-drawer-tags contact-panel-tags">
                {contactItems.map(({ label, Icon }) => (
                  <span key={label}>
                    <Icon size={13} />
                    {label}
                  </span>
                ))}
              </div>
              <small>{t('note') as string}</small>
            </div>
          </aside>
        </>
      )}
    </>
  );
};
