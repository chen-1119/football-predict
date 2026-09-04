import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { ContactDock } from './ContactDock';

export const Footer: React.FC = () => {
  const { language } = useApp();

  const translations = {
    brand: { zh: '足球数据看板', en: 'Football Data Board' },
    tagline: {
      zh: '基于中国竞彩网官方赛程与赔率快照，提供轻量化赛前数据看板。',
      en: 'A lightweight pre-match dashboard based on official Sporttery fixtures and odds snapshots.'
    },
    responsible: { zh: '18+ 理性提示', en: '18+ Notice' },
    warning: {
      zh: '本站仅提供数据分析与赛前推荐参考，不保证赛果。请保持娱乐心态，禁止未成年人参与，切勿盲目跟单。',
      en: 'Analytics and pre-match picks are for reference only and do not guarantee results. Please stay responsible, 18+ only, and never follow picks blindly.'
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
      zh: '本站使用 localStorage 保存 football_access_session（访问令牌与到期时间）、nerdy_lang（语言）、nerdy_user（校验显示状态）、nerdy_hw_submission（本地选择）和 football_worldcup_prediction_wall（本设备昵称、评论与预测）。服务切换期间还会在当前标签页的 sessionStorage 中短暂保留最多 3 分钟的最近一次已验证赛程；它仅用于连续显示，不参与串关生成，并会在退出、访问失效或标签页关闭时清除。访问令牌只会发送到本站配置的受保护 API（本机部署默认为同源）；服务端会记录校验码状态、使用次数和时间。本设备预测记录不会上传或共享。退出校验会清除访问状态；清除本站浏览器数据可删除全部本地记录。',
      en: 'This site uses localStorage for football_access_session (access token and expiry), nerdy_lang (language), nerdy_user (verification display state), nerdy_hw_submission (local selections), and football_worldcup_prediction_wall (on-device nickname, comment, and picks). During a service cutover, the current tab may also retain the last verified schedule in sessionStorage for up to three minutes. It is display-only, cannot enter bet-slip generation, and is cleared on sign-out, access expiry, or tab close. The access token is sent only to this site\'s configured protected API (same-origin by default on this deployment); the server records access-code status, use count, and timestamps. On-device prediction-wall entries are not uploaded or shared. Clearing access removes verification state, and clearing this site\'s browser data removes all local entries.'
    },
    copyright: { zh: '© 2026 足球数据看板', en: '© 2026 Football Data Board' }
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
          <div className="footer-policy-list app-footer-policies" aria-label={t('policyNavigation') as string}>
            {policyItems.map((item) => (
              <details className="footer-policy-details app-footer-policy" key={item.key}>
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
