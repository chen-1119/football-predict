import React, { useEffect, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { ContactDock } from './ContactDock';

export const Footer: React.FC = () => {
  const { language } = useApp();
  const policyRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closePolicies = () => policyRootRef.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(detail => { detail.open = false; });
    const pointer = (event: PointerEvent) => { if (!policyRootRef.current?.contains(event.target as Node)) closePolicies(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !policyRootRef.current?.contains(event.target as Node)) return;
      const detail = (event.target as Element).closest('details');
      closePolicies(); detail?.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard); };
  }, []);

  const translations = {
    brand: { zh: '90分钟足球', en: '90’ Football' },
    tagline: {
      zh: '赛前数据，赛后复盘。',
      en: 'Pre-match insights. Post-match review.'
    },
    responsible: { zh: '18+ 理性提示', en: '18+ Notice' },
    warning: {
      zh: '数据与模型仅供参考，不保证赛果或收益。请理性对待，未成年人禁止参与。',
      en: 'Data and models are for reference only, with no guaranteed results or returns. Stay responsible. Adults 18+ only.'
    },
    about: { zh: '关于我们', en: 'About' },
    terms: { zh: '服务条款', en: 'Terms' },
    privacy: { zh: '隐私政策', en: 'Privacy' },
    policyNavigation: { zh: '关于、条款与隐私说明', en: 'About, terms, and privacy information' },
    aboutBody: {
      zh: '本站是足球赛前数据看板，整理官方竞彩赛程与赔率快照，并以可核验的数据质量和模型风险状态辅助赛前研究。联系方式二维码为本站静态图片。',
      en: 'This site is a pre-match football data dashboard. It organizes official Sporttery fixtures and odds snapshots and exposes data-quality and model-risk status for research. The contact QR code is a static first-party image.'
    },
    termsBody: {
      zh: '内容仅供数据研究、娱乐和赛前讨论，不构成投注、财务或收益承诺。模型与推荐可能出错，赛果不受保证；仅限 18 岁以上用户，并请遵守所在地法律与平台规则。',
      en: 'Content is for data research, entertainment, and pre-match discussion only. It is not betting or financial advice and does not promise returns. Models and picks can be wrong; results are never guaranteed. Users must be 18+ and follow applicable laws and platform rules.'
    },
    privacyBody: {
      zh: '注册账号时，服务器保存账号名、显示名称、密码及恢复码的安全摘要；密码与恢复码明文不写入数据库。登录使用仅本站服务端可读取的安全 Cookie。个人关注、关注时推荐引用、体验权益、登录与管理操作记录保存在本站 PostgreSQL，用于跨设备同步、权限校验与安全审计。退出登录会撤销该会话，不删除账号和关注；可在“我的”退出其他设备，或逐条取消关注。登录前待保存的关注最多在标签页保留 30 分钟。旧访问码兼容期间，本站使用 localStorage 保存 football_access_session（访问令牌与到期时间）、nerdy_lang（语言）、nerdy_user（校验显示状态）、nerdy_hw_submission（本地选择）和 football_worldcup_prediction_wall（本设备昵称、评论与预测）。服务切换期间还会在当前标签页的 sessionStorage 中短暂保留最多 3 分钟的最近一次已验证赛程；它仅用于连续显示，不参与串关生成，并会在退出、访问失效或标签页关闭时清除。访问令牌只会发送到本站配置的受保护 API（本机部署默认为同源）；服务端会记录校验码状态、使用次数和时间。本设备预测记录不会上传或共享。退出校验会清除访问状态；清除本站浏览器数据可删除全部本地记录。',
      en: 'The server stores your username, display name, password and recovery-code hashes; plaintext passwords and recovery codes are not stored in the database. Sign-in uses a secure, HttpOnly first-party cookie. Followed matches, frozen pick references, access grants and sign-in/admin audit events are stored in our PostgreSQL database for cross-device access, authorization and security. Signing out revokes that session but retains the account and follows. My account can revoke other sessions; follows can be removed individually. A pending follow is retained in the tab for up to 30 minutes. During legacy-code compatibility, this site uses localStorage for football_access_session (access token and expiry), nerdy_lang (language), nerdy_user (verification display state), nerdy_hw_submission (local selections), and football_worldcup_prediction_wall (on-device nickname, comment, and picks). During a service cutover, the current tab may also retain the last verified schedule in sessionStorage for up to three minutes. It is display-only, cannot enter bet-slip generation, and is cleared on sign-out, access expiry, or tab close. The access token is sent only to this site\'s configured protected API (same-origin by default on this deployment); the server records access-code status, use count, and timestamps. On-device prediction-wall entries are not uploaded or shared. Clearing access removes verification state, and clearing this site\'s browser data removes all local entries.'
    },
    copyright: { zh: '© 2026 90分钟足球', en: '© 2026 90’ Football' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];
  const policyItems = [
    { key: 'about', title: t('about') as string, body: t('aboutBody') as string },
    { key: 'terms', title: t('terms') as string, body: t('termsBody') as string },
    { key: 'privacy', title: t('privacy') as string, body: t('privacyBody') as string }
  ];

  return (
    <footer className="site-footer app-footer">
      <div className="container app-footer-inner">
        <div className="app-footer-brand">
          <span className="app-footer-mark" aria-hidden="true">90</span>
          <span>
            <strong>{t('brand') as string}</strong>
            <small>{t('tagline') as string}</small>
          </span>
        </div>

        <div className="app-footer-notice">
          <span className="app-footer-notice-title">
            <ShieldAlert size={15} />
            {t('responsible') as string}
          </span>
          <p>{t('warning') as string}</p>
        </div>

        <div className="app-footer-actions">
          <div className="footer-policy-list app-footer-policies" aria-label={t('policyNavigation') as string} ref={policyRootRef}>
            {policyItems.map((item) => (
              <details className="footer-policy-details app-footer-policy" key={item.key} onToggle={(event) => {
                const current = event.currentTarget;
                if (current.open) policyRootRef.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(detail => { if (detail !== current) detail.open = false; });
              }}>
                <summary>{item.title}</summary>
                <p>{item.body}</p>
              </details>
            ))}
          </div>
          <ContactDock />
          <span className="app-footer-copyright">{t('copyright') as string}</span>
        </div>
      </div>
    </footer>
  );
};
