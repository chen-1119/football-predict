import React from 'react';
import { useApp } from '../context/AppContextCore';
import { Crown, Database, ExternalLink, Handshake, MessageCircle, ScanLine, ShieldAlert } from 'lucide-react';

export const Footer: React.FC = () => {
  const { language } = useApp();

  const translations = {
    brand: { zh: 'AI 足球预测', en: 'AI Football' },
    tagline: {
      zh: '基于中国竞彩网官方赛程与 SP 快照，提供轻量化赛前数据看板。',
      en: 'A lightweight pre-match dashboard based on official Sporttery fixtures and SP snapshots.'
    },
    data: { zh: '数据', en: 'Data' },
    dataItems: {
      zh: ['官方 SP 快照', '胜平负 / 让球', '历史赛果', '每日自动同步'],
      en: ['Official SP snapshots', '1X2 / Handicap', 'Historical results', 'Daily auto sync']
    },
    leagues: { zh: '常用赛事', en: 'Leagues' },
    leagueItems: {
      zh: ['国际赛', '英超', '西甲', '德甲', '意甲', '法甲'],
      en: ['International', 'EPL', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1']
    },
    contact: { zh: '联系方式', en: 'Contact' },
    contactKicker: { zh: '微信咨询', en: 'WeChat' },
    contactName: { zh: '何先生', en: 'Mr. He' },
    contactDesc: { zh: '赛事数据、合作与会员服务', en: 'Data, partnership, and membership service' },
    scan: { zh: '微信扫一扫添加', en: 'Scan with WeChat' },
    contactNote: { zh: '添加时备注：足球预测', en: 'Add note: Football prediction' },
    responsible: { zh: '18+ 理性提示', en: '18+ Notice' },
    warning: {
      zh: '本平台仅提供数据分析与预测参考，不保证赛果。请保持娱乐心态，禁止未成年人参与，切勿盲目跟单。',
      en: 'Analytics are for reference only and do not guarantee results. Please stay responsible, 18+ only, and never follow picks blindly.'
    },
    about: { zh: '关于我们', en: 'About' },
    terms: { zh: '服务条款', en: 'Terms' },
    privacy: { zh: '隐私政策', en: 'Privacy' },
    copyright: { zh: '© 2026 AI 足球预测', en: '© 2026 AI Football' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];
  const dataItems = t('dataItems') as string[];
  const leagueItems = t('leagueItems') as string[];
  const contactItems = language === 'zh'
    ? [
      { label: '赛事数据', icon: Database },
      { label: '合作咨询', icon: Handshake },
      { label: '会员服务', icon: Crown }
    ]
    : [
      { label: 'Match data', icon: Database },
      { label: 'Partnership', icon: Handshake },
      { label: 'Membership', icon: Crown }
    ];

  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-main">
          <section className="footer-brand">
            <div className="footer-brand-row">
              <span className="footer-mark" aria-hidden="true">AI</span>
              <strong>{t('brand') as string}</strong>
            </div>
            <p>{t('tagline') as string}</p>
          </section>

          <section className="footer-section">
            <h3>{t('data') as string}</h3>
            <div className="footer-chip-list">
              {dataItems.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </section>

          <section className="footer-section">
            <h3>{t('leagues') as string}</h3>
            <div className="footer-chip-list">
              {leagueItems.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </section>

          <section className="footer-contact">
            <div className="footer-section-title">
              <MessageCircle size={15} />
              <h3>{t('contact') as string}</h3>
            </div>
            <div className="footer-contact-card">
              <div className="footer-qr-frame">
                <img src="./contact-qr-code.jpg" alt={t('scan') as string} loading="lazy" />
              </div>
              <div className="footer-contact-copy">
                <span className="footer-contact-kicker">
                  <ScanLine size={13} />
                  {t('contactKicker') as string}
                </span>
                <strong>{t('contactName') as string}</strong>
                <p>{t('contactDesc') as string}</p>
                <div className="footer-contact-tags">
                  {contactItems.map(({ label, icon: Icon }) => (
                    <span key={label}>
                      <Icon size={12} />
                      {label}
                    </span>
                  ))}
                </div>
                <small>{t('contactNote') as string}</small>
              </div>
            </div>
          </section>
        </div>

        <div className="footer-notice">
          <span className="footer-notice-title">
            <ShieldAlert size={16} />
            {t('responsible') as string}
          </span>
          <p>{t('warning') as string}</p>
        </div>

        <div className="footer-bottom">
          <span>{t('copyright') as string}</span>
          <nav aria-label="Footer links">
            <a href="#">
              {t('about') as string}
              <ExternalLink size={12} />
            </a>
            <a href="#">
              {t('terms') as string}
              <ExternalLink size={12} />
            </a>
            <a href="#">
              {t('privacy') as string}
              <ExternalLink size={12} />
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
};
