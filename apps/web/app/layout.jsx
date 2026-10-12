import Link from 'next/link';
import './site.css';
export const metadata = { title: { default: '饭点聊球 · 竞彩足球', template: '%s · 饭点聊球' },
  description: '竞彩足球赛程、赛前分析与原发布记录。展示数据观察时间，保留原方向、比分和发布赔率。' };
export default function Layout({ children }) {
  return <html lang="zh-CN"><body><header className="site-header"><Link href="/" className="brand">饭点聊球</Link>
    <nav><Link href="/">今日赛程</Link><Link href="/best">单场推荐</Link><Link href="/best?tab=two">2串1</Link><Link href="/best?tab=three">3串1</Link>
      <a href={process.env.FOOTBALL_EXISTING_SITE_ORIGIN || 'https://134.175.132.183'}>原站</a></nav></header>
    <main>{process.env.FOOTBALL_PREVIEW_CAPTURE_TOKEN && <p className="notice" data-preview-mode="readonly-capture">第一版本地预览 · 使用生产数据库只读采样，非实时线上服务。历史推荐保留原发布方向与赔率。</p>}{children}</main><footer>按竞彩日保存原发布内容。赔率展示观察时间，已截止场次仅供历史查看。</footer></body></html>;
}
