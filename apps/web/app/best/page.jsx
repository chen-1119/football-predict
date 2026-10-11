import { cookies } from 'next/headers';
import data from '../../lib/data.cjs';
import { ReviewedAnalysisPanel } from '../../../../src/components/recommendations/ReviewedAnalysis';
import { LeagueBaselineDirections } from '../../../../src/components/recommendations/LeagueBaselineDirections';
import { parseRecommendationCenter } from '../../../../src/services/recommendationCenterView';
export const dynamic = 'force-dynamic';
export const metadata = { title: '已发布赛前分析', robots: { index: false, follow: false } };
export default async function Best({ searchParams }) {
  const params = await searchParams, tab = ['two', 'three'].includes(params.tab) ? params.tab : 'single';
  const jar = await cookies(), response = await data.loadRecommendations(jar.toString());
  if (!response.ok) return <><h1>赛前分析</h1><p className="notice">{response.accessRequired ? '请先在原站登录或验证访问码。登录内容继续在原站提供。' : '分析读取暂时未完成，原发布记录仍保留，请查看原站。'}</p><a href={process.env.FOOTBALL_EXISTING_SITE_ORIGIN || 'https://134.175.132.183'}>打开原站</a></>;
  let center;
  try { center = parseRecommendationCenter(response); }
  catch { return <><h1>赛前分析</h1><p className="notice">分析版本暂时不能核对，请查看原站保留的发布记录。</p></>; }
  const reviewed = center?.reviewedAnalysis?.records?.length ? center.reviewedAnalysis : center?.reviewedAnalysisHistory;
  return <><h1>{tab === 'two' ? '精选2串1' : tab === 'three' ? '精选3串1' : '已发布赛前分析'}</h1>
    <ReviewedAnalysisPanel data={reviewed} tab={tab} now={Date.now()} failed={false}/>
    {!reviewed?.records?.length && <p className="notice">暂无已提交的人工审核分析，请查看原站的球队模型参考与历史记录。</p>}
    {tab === 'single' && <LeagueBaselineDirections data={center.leagueBaseline} language="zh" now={Date.now()} failed={false}/>}
  </>;
}
