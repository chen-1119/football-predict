import React from 'react';
import { useApp } from '../context/AppContext';
import { bettingGlossary } from '../services/mockData';
import { X } from 'lucide-react';

interface GlossaryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const GlossaryModal: React.FC<GlossaryModalProps> = ({ isOpen, onClose }) => {
  const { language } = useApp();

  if (!isOpen) return null;

  const translations = {
    title: { zh: '足球投注术语说明', en: 'Betting Glossary' },
    subtitle: { zh: '在这里您可以了解本站预测列表中出现的各项缩写与推荐术语的含义。', en: 'Understand abbreviations and prediction types used on our platform.' },
    close: { zh: '关闭', en: 'Close' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid hsl(var(--border))', paddingBottom: '0.75rem' }}>
          <div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '700', fontFamily: 'var(--font-title)' }}>
              {t('title')}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))', marginTop: '0.25rem' }}>
              {t('subtitle')}
            </p>
          </div>
          <button onClick={onClose} className="btn btn-secondary" style={{ padding: '0.35rem', borderRadius: '50%' }}>
            <X size={18} />
          </button>
        </div>

        {/* Glossary List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '55vh', overflowY: 'auto', paddingRight: '0.5rem' }}>
          {bettingGlossary.map((item, idx) => (
            <div 
              key={idx} 
              style={{
                display: 'flex',
                gap: '1rem',
                padding: '1rem',
                backgroundColor: 'hsl(var(--bg))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '12px',
                transition: 'border-color 0.2s',
              }}
            >
              {/* Short Code Badge */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'hsl(var(--primary) / 0.12)',
                color: 'hsl(var(--primary))',
                fontWeight: '800',
                fontSize: '1rem',
                minWidth: '60px',
                height: '44px',
                borderRadius: '8px',
                border: '1px solid hsl(var(--primary) / 0.2)'
              }}>
                {item.term}
              </div>

              {/* Text */}
              <div>
                <h4 style={{ fontSize: '0.95rem', fontWeight: '700', color: 'hsl(var(--text-primary))', marginBottom: '0.25rem' }}>
                  {item.name[language]}
                </h4>
                <p style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', lineHeight: '1.5' }}>
                  {item.desc[language]}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Footer actions */}
        <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid hsl(var(--border))', paddingTop: '1rem' }}>
          <button onClick={onClose} className="btn btn-primary">
            {t('close')}
          </button>
        </div>

      </div>
    </div>
  );
};
