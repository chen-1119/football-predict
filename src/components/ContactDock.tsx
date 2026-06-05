import React, { useEffect, useState } from 'react';
import { Crown, Database, Handshake, MessageCircle, ScanLine, X } from 'lucide-react';
import { useApp } from '../context/AppContextCore';

export const ContactDock: React.FC = () => {
  const { language } = useApp();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const translations = {
    open: { zh: '微信联系', en: 'Contact' },
    title: { zh: '联系方式', en: 'Contact' },
    kicker: { zh: '微信咨询', en: 'WeChat' },
    name: { zh: '何先生', en: 'Mr. He' },
    desc: {
      zh: '扫码添加微信，咨询赛事数据、合作与会员服务。',
      en: 'Scan to add WeChat for match data, partnership, and membership service.'
    },
    scan: { zh: '微信扫一扫添加', en: 'Scan with WeChat' },
    note: { zh: '添加时备注：足球预测', en: 'Add note: Football prediction' },
    close: { zh: '关闭联系方式', en: 'Close contact panel' },
    items: {
      zh: ['赛事数据', '合作咨询', '会员服务'],
      en: ['Match data', 'Partnership', 'Membership']
    }
  };

  const t = (key: keyof typeof translations) => translations[key][language];
  const contactItems = (t('items') as string[]).map((label, index) => {
    const icons = [Database, Handshake, Crown];
    return { label, Icon: icons[index] };
  });

  return (
    <>
      <button
        type="button"
        className="contact-dock-button"
        aria-label={t('open') as string}
        aria-expanded={isOpen}
        aria-controls="contact-drawer"
        onClick={() => setIsOpen(true)}
      >
        <MessageCircle size={18} />
        <span>{t('open') as string}</span>
      </button>

      <div
        className={`contact-drawer-backdrop ${isOpen ? 'is-open' : ''}`}
        aria-hidden={!isOpen}
        onClick={() => setIsOpen(false)}
      />

      <aside
        id="contact-drawer"
        className={`contact-drawer ${isOpen ? 'is-open' : ''}`}
        aria-hidden={!isOpen}
      >
        <div className="contact-drawer-head">
          <div>
            <span className="contact-drawer-kicker">
              <ScanLine size={14} />
              {t('kicker') as string}
            </span>
            <h2>{t('title') as string}</h2>
          </div>
          <button
            type="button"
            className="contact-drawer-close"
            aria-label={t('close') as string}
            onClick={() => setIsOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <div className="contact-drawer-body">
          <div className="contact-drawer-qr">
            <img src="./contact-qr-code.jpg" alt={t('scan') as string} loading="lazy" />
          </div>
          <div className="contact-drawer-copy">
            <strong>{language === 'zh' ? `微信：${t('name') as string}` : `WeChat: ${t('name') as string}`}</strong>
            <p>{t('desc') as string}</p>
          </div>
          <div className="contact-drawer-tags">
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
  );
};
