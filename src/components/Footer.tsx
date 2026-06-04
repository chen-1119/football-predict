import React from 'react';
import { useApp } from '../context/AppContextCore';
import { Smartphone } from 'lucide-react';

export const Footer: React.FC = () => {
  const { language } = useApp();

  const translations = {
    about: { zh: '关于我们', en: 'About Us' },
    terms: { zh: '服务条款', en: 'Terms of Service' },
    privacy: { zh: '隐私政策', en: 'Privacy Policy' },
    popularLeagues: { zh: '顶级联赛', en: 'Popular Leagues' },
    contact: { zh: '联系方式', en: 'Contact' },
    contactName: { zh: '微信：何先生', en: 'WeChat: Mr. He' },
    contactDesc: { zh: '扫码添加微信，获取赛事数据、合作与会员咨询。', en: 'Scan to add WeChat for data, partnership, and membership inquiries.' },
    epl: { zh: '英格兰超级联赛 (英超)', en: 'Premier League' },
    laliga: { zh: '西班牙甲级联赛 (西甲)', en: 'La Liga' },
    bundesliga: { zh: '德国甲级联赛 (德甲)', en: 'Bundesliga' },
    seriea: { zh: '意大利甲级联赛 (意甲)', en: 'Serie A' },
    ligue1: { zh: '法国甲级联赛 (法甲)', en: 'Ligue 1' },
    responsibleGambling: { zh: '18+ 理性博彩提示', en: '18+ Responsible Gambling' },
    gambleWarning: {
      zh: '提示：本平台仅提供人工智能数据分析与预测推荐，所有数据不代表平台绝对保证。足球比赛瞬息万变，请保持娱乐心态，理性博彩，禁止未满 18 岁未成年人参与下注。切勿盲目跟单，量力而行。',
      en: 'Disclaimer: This platform provides AI data predictions and analytics for informational and entertainment purposes only. Football matches are highly unpredictable. Please gamble responsibly. strictly 18+. Do not bet more than you can afford to lose.'
    },
    copyright: { zh: '© 2026 AI 足球预测. 保留所有权利。本项目为产品形态复刻版。', en: '© 2026 AI Predict. All rights reserved. Replica product edition.' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  return (
    <footer style={{ backgroundColor: 'hsl(var(--bg-card))', borderTop: '1px solid hsl(var(--border))', padding: '3rem 0 2rem 0', marginTop: '4rem' }}>
      <div className="container">
        
        {/* Top grids */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '2.5rem', marginBottom: '2.5rem' }}>
          
          {/* Brand and Description */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <div style={{
                background: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 100%)',
                width: '28px', height: '28px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: '800', color: '#000', fontSize: '1rem'
              }}>
                Ω
              </div>
              <span className="primary-gradient-text" style={{ fontSize: '1.2rem' }}>
                {language === 'zh' ? 'AI 足球预测' : 'AI Predict'}
              </span>
            </div>
            <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.875rem', lineHeight: '1.6' }}>
              {language === 'zh' 
                ? '我们利用先进的深度学习预测算法模型，对全球数以百计的赛事 SP、伤停、xG 数据进行深度挖掘，为您提供最高质量的赛前推演。'
                : 'We leverage state-of-the-art deep learning predictive models to mine odds, injuries, and xG data, delivering elite football analytics daily.'
              }
            </p>
          </div>

          {/* Quick Leagues */}
          <div>
            <h4 style={{ color: 'hsl(var(--text-primary))', marginBottom: '1rem', fontSize: '0.95rem', fontWeight: '700' }}>
              {t('popularLeagues')}
            </h4>
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.85rem', color: 'hsl(var(--text-secondary))' }}>
              <li>{t('epl')}</li>
              <li>{t('laliga')}</li>
              <li>{t('bundesliga')}</li>
              <li>{t('seriea')}</li>
              <li>{t('ligue1')}</li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 style={{ color: 'hsl(var(--text-primary))', marginBottom: '1rem', fontSize: '0.95rem', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Smartphone size={16} />
              {t('contact')}
            </h4>
            <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.85rem', marginBottom: '0.85rem', lineHeight: '1.5' }}>
              {t('contactDesc')}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
              <img
                src="./contact-qr.jpg"
                alt={t('contactName')}
                loading="lazy"
                style={{
                  width: '108px',
                  height: '108px',
                  objectFit: 'cover',
                  borderRadius: '8px',
                  border: '1px solid hsl(var(--border))',
                  backgroundColor: '#fff'
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ color: 'hsl(var(--text-primary))', fontWeight: 700, fontSize: '0.9rem' }}>{t('contactName')}</span>
                <span style={{ color: 'hsl(var(--text-muted))', fontSize: '0.78rem' }}>{language === 'zh' ? '微信扫码添加' : 'Scan with WeChat'}</span>
              </div>
            </div>
          </div>

        </div>

        {/* Responsible Gambling Notice */}
        <div style={{
          borderTop: '1px solid hsl(var(--border))',
          borderBottom: '1px solid hsl(var(--border))',
          padding: '1.5rem 0',
          margin: '2rem 0',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'hsl(var(--premium))', fontWeight: '700', fontSize: '0.95rem' }}>
            <span style={{ border: '2px solid hsl(var(--premium))', borderRadius: '50%', width: '22px', height: '22px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>18+</span>
            <span>{t('responsibleGambling')}</span>
          </div>
          <p style={{ color: 'hsl(var(--text-muted))', fontSize: '0.8rem', lineHeight: '1.6' }}>
            {t('gambleWarning')}
          </p>
        </div>

        {/* Bottom copyright */}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', fontSize: '0.8rem', color: 'hsl(var(--text-muted))' }}>
          <span>{t('copyright')}</span>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <a href="#">{t('about')}</a>
            <span>•</span>
            <a href="#">{t('terms')}</a>
            <span>•</span>
            <a href="#">{t('privacy')}</a>
          </div>
        </div>

      </div>
    </footer>
  );
};
