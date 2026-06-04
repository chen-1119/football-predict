import React, { useState } from 'react';
import { useApp } from '../context/AppContextCore';
import { LogIn, UserPlus, Key, User as UserIcon } from 'lucide-react';

interface AuthProps {
  onSuccess: () => void;
}

export const Auth: React.FC<AuthProps> = ({ onSuccess }) => {
  const { language, login, register } = useApp();
  const [isLoginView, setIsLoginView] = useState<boolean>(true);
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const translations = {
    loginTitle: { zh: '登录您的账户', en: 'Log In to Your Account' },
    registerTitle: { zh: '创建新账户', en: 'Create New Account' },
    usernameLabel: { zh: '用户名 / 电子邮箱', en: 'Username / Email' },
    passwordLabel: { zh: '密码', en: 'Password' },
    loginBtn: { zh: '立即登录', en: 'Sign In' },
    registerBtn: { zh: '立即注册', en: 'Sign Up' },
    toggleToRegister: { zh: '还没有账户？立即注册', en: 'No account? Register now' },
    toggleToLogin: { zh: '已有账户？立即登录', en: 'Already have an account? Sign In' },
    fieldsRequired: { zh: '请输入完整的用户名和密码！', en: 'Please fill in all fields!' },
    pwTooShort: { zh: '密码长度不能少于 6 位！', en: 'Password must be at least 6 characters!' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!username.trim() || !password.trim()) {
      setError(t('fieldsRequired'));
      return;
    }

    if (password.length < 6) {
      setError(t('pwTooShort'));
      return;
    }

    if (isLoginView) {
      login(username);
    } else {
      register(username);
    }

    // 成功后回调
    onSuccess();
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh', padding: '2rem 0' }}>
      <div className="card" style={{ width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        
        {/* Title */}
        <div style={{ textAlign: 'center' }}>
          <h3 style={{ fontSize: '1.5rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
            {isLoginView ? t('loginTitle') : t('registerTitle')}
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))', marginTop: '0.25rem' }}>
            {isLoginView 
              ? (language === 'zh' ? '登录后可保存您的投注单历史和提交命中赢奖活动。' : 'Sign in to save slips and participate in Hit & Win.')
              : (language === 'zh' ? '开启您的 AI 足球预测精准之旅。' : 'Start your journey with elite AI predictions.')
            }
          </p>
        </div>

        {/* Error Alert */}
        {error && (
          <div style={{
            backgroundColor: 'hsl(var(--danger) / 0.15)',
            border: '1px solid hsl(var(--danger) / 0.3)',
            color: 'hsl(var(--danger))',
            padding: '0.75rem',
            borderRadius: '10px',
            fontSize: '0.8rem',
            fontWeight: '600',
            textAlign: 'center'
          }}>
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <UserIcon size={14} />
              <span>{t('usernameLabel')}</span>
            </label>
            <input 
              type="text" 
              className="form-input"
              placeholder="e.g. nerd_footballer"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Key size={14} />
              <span>{t('passwordLabel')}</span>
            </label>
            <input 
              type="password" 
              className="form-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', height: '44px', marginTop: '0.5rem' }}>
            {isLoginView ? <LogIn size={16} /> : <UserPlus size={16} />}
            <span>{isLoginView ? t('loginBtn') : t('registerBtn')}</span>
          </button>

        </form>

        {/* Form Toggle */}
        <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '1rem', textAlign: 'center' }}>
          <button 
            onClick={() => {
              setIsLoginView(!isLoginView);
              setError(null);
            }}
            className="btn btn-secondary"
            style={{ border: 'none', background: 'none', color: 'hsl(var(--accent))', fontSize: '0.8rem', fontWeight: '500' }}
          >
            {isLoginView ? t('toggleToRegister') : t('toggleToLogin')}
          </button>
        </div>

      </div>
    </div>
  );
};
