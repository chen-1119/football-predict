const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultZip = path.join(os.homedir(), "Desktop", "Kimi_Agent_2026 世界杯数据全景数据.zip");
const zipPath = path.resolve(process.argv[2] || process.env.KIMI_WORLDCUP_ZIP || defaultZip);
const python = process.env.KIMI_WORLDCUP_PYTHON || process.env.PYTHON || "python";

if (!fs.existsSync(zipPath)) {
  console.error(`Kimi World Cup zip not found: ${zipPath}`);
  process.exit(1);
}

const zipHash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
const outputDir = path.join(rootDir, "server-data", "worldcup");
const publicDataDir = path.join(rootDir, "public", "data");
const srcDataFile = path.join(rootDir, "src", "services", "worldCupKimiDataset.ts");
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(publicDataDir, { recursive: true });

const pySource = String.raw`
import io
import json
import math
import re
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from openpyxl import load_workbook

zip_path = Path(sys.argv[1])
zip_hash = sys.argv[2]

TEAM_ALIASES = {
    "墨西哥": "mexico", "南非": "south-africa", "韩国": "south-korea", "捷克": "czechia",
    "加拿大": "canada", "瑞士": "switzerland", "卡塔尔": "qatar", "波黑": "bosnia",
    "巴西": "brazil", "摩洛哥": "morocco", "海地": "haiti", "苏格兰": "scotland",
    "美国": "usa", "土耳其": "turkey", "澳大利亚": "australia", "巴拉圭": "paraguay",
    "德国": "germany", "库拉索": "curacao", "科特迪瓦": "ivory-coast", "厄瓜多尔": "ecuador",
    "荷兰": "netherlands", "日本": "japan", "瑞典": "sweden", "突尼斯": "tunisia",
    "比利时": "belgium", "埃及": "egypt", "伊朗": "iran", "新西兰": "new-zealand",
    "西班牙": "spain", "佛得角": "cape-verde", "沙特阿拉伯": "saudi-arabia", "沙特": "saudi-arabia",
    "乌拉圭": "uruguay", "法国": "france", "塞内加尔": "senegal", "挪威": "norway",
    "伊拉克": "iraq", "阿根廷": "argentina", "阿尔及利亚": "algeria", "奥地利": "austria",
    "约旦": "jordan", "葡萄牙": "portugal", "乌兹别克斯坦": "uzbekistan", "乌兹别克": "uzbekistan",
    "哥伦比亚": "colombia", "刚果民主共和国": "dr-congo", "刚果民主": "dr-congo",
    "刚果(金)": "dr-congo", "刚果（金）": "dr-congo",
    "英格兰": "england", "克罗地亚": "croatia", "加纳": "ghana", "巴拿马": "panama",
}

KEY_TO_EN = {
    "mexico": "Mexico", "south-africa": "South Africa", "south-korea": "Korea Republic", "czechia": "Czechia",
    "canada": "Canada", "switzerland": "Switzerland", "qatar": "Qatar", "bosnia": "Bosnia and Herzegovina",
    "brazil": "Brazil", "morocco": "Morocco", "haiti": "Haiti", "scotland": "Scotland",
    "usa": "United States", "turkey": "Turkey", "australia": "Australia", "paraguay": "Paraguay",
    "germany": "Germany", "curacao": "Curacao", "ivory-coast": "Ivory Coast", "ecuador": "Ecuador",
    "netherlands": "Netherlands", "japan": "Japan", "sweden": "Sweden", "tunisia": "Tunisia",
    "belgium": "Belgium", "egypt": "Egypt", "iran": "Iran", "new-zealand": "New Zealand",
    "spain": "Spain", "cape-verde": "Cape Verde", "saudi-arabia": "Saudi Arabia", "uruguay": "Uruguay",
    "france": "France", "senegal": "Senegal", "norway": "Norway", "iraq": "Iraq",
    "argentina": "Argentina", "algeria": "Algeria", "austria": "Austria", "jordan": "Jordan",
    "portugal": "Portugal", "uzbekistan": "Uzbekistan", "colombia": "Colombia", "dr-congo": "DR Congo",
    "england": "England", "croatia": "Croatia", "ghana": "Ghana", "panama": "Panama",
}

def num(value):
    if value in (None, ""):
        return None
    try:
        n = float(value)
        if not math.isfinite(n):
            return None
        return int(n) if n.is_integer() else round(n, 4)
    except Exception:
        return None

def text(value):
    if value is None:
        return ""
    return str(value).strip()

def team_key(value):
    raw = text(value)
    if raw in TEAM_ALIASES:
        return TEAM_ALIASES[raw]
    cleaned = re.sub(r"[\s·.()（）'\-_/]+", "", raw.lower())
    for zh, key in TEAM_ALIASES.items():
        if re.sub(r"[\s·.()（）'\-_/]+", "", zh.lower()) == cleaned:
            return key
    return re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")

def group_id(value):
    raw = text(value)
    match = re.search(r"([A-L])", raw, re.I)
    return match.group(1).upper() if match else raw

def parse_recent_form(value):
    raw = text(value)
    m = re.search(r"(\d+)\s*胜\s*(\d+)\s*平\s*(\d+)\s*负", raw)
    if not m:
        return {"raw": raw, "wins": None, "draws": None, "losses": None, "points": None}
    wins, draws, losses = [int(x) for x in m.groups()]
    return {"raw": raw, "wins": wins, "draws": draws, "losses": losses, "points": wins * 3 + draws}

def parse_kickoff(value):
    raw = text(value)
    m = re.search(r"(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?", raw)
    if not m:
        return None
    year = int(m.group(1) or 2026)
    month = int(m.group(2))
    day = int(m.group(3))
    hour = int(m.group(4) or 0)
    minute = int(m.group(5) or 0)
    return f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:00+08:00"

def rows_from(ws, header_row, data_start=None):
    header = [cell.value for cell in next(ws.iter_rows(min_row=header_row, max_row=header_row))]
    out = []
    for row in ws.iter_rows(min_row=data_start or header_row + 1, values_only=True):
        if not any(text(v) for v in row):
            continue
        item = {}
        for idx, value in enumerate(row):
            key = text(header[idx]) if idx < len(header) and header[idx] is not None else f"col{idx + 1}"
            item[key] = value
        out.append(item)
    return out

def row_values(ws, start):
    return [row for row in ws.iter_rows(min_row=start, values_only=True) if any(text(v) for v in row)]

def find_book(zf, prefix):
    for name in zf.namelist():
        if name.endswith(".xlsx") and name.startswith(prefix):
            return load_workbook(io.BytesIO(zf.read(name)), read_only=True, data_only=True), name
    return None, ""

with zipfile.ZipFile(zip_path, "r") as zf:
    curated_wb, curated_name = find_book(zf, "2026")
    raw_wb, raw_name = find_book(zf, "test_raw")

if curated_wb is None:
    raise SystemExit("Curated workbook not found in zip")

curated_team_rows = rows_from(curated_wb["国家队分析"], 4)
position_rows = rows_from(curated_wb["位置分析"], 4)
value_rows = rows_from(curated_wb["身价分析"], 4)
group_rows = rows_from(curated_wb["小组形势"], 4)
fixture_rows = rows_from(curated_wb["赛程表"], 4)
player_rows = rows_from(curated_wb["球员数据库"], 4)
scorer_rows = rows_from(curated_wb["射手榜预测"], 4)
league_rows = rows_from(curated_wb["联赛分布"], 4)
age_rows = rows_from(curated_wb["年龄分析"], 4)

raw_strength_rows = []
raw_group_rows = []
raw_fixture_rows = []
raw_player_rows = []
if raw_wb is not None:
    raw_strength_rows = rows_from(raw_wb["球队战力"], 4)
    raw_group_rows = rows_from(raw_wb["小组形势"], 4)
    raw_fixture_rows = rows_from(raw_wb["赛程月历"], 4)
    raw_player_rows = rows_from(raw_wb["球员数据库"], 2)

position_by_key = {}
for row in position_rows:
    key = team_key(row.get("国家"))
    if key:
        position_by_key[key] = {
            "counts": {
                "gk": num(row.get("GK人数")), "df": num(row.get("DF人数")),
                "mf": num(row.get("MF人数")), "fw": num(row.get("FW人数")),
            },
            "avgValueM": {
                "gk": num(row.get("GK平均身价")), "df": num(row.get("DF平均身价")),
                "mf": num(row.get("MF平均身价")), "fw": num(row.get("FW平均身价")),
            },
            "avgAge": {
                "gk": num(row.get("GK平均年龄")), "df": num(row.get("DF平均年龄")),
                "mf": num(row.get("MF平均年龄")), "fw": num(row.get("FW平均年龄")),
            },
        }

market_value_by_key = {}
for row in value_rows:
    key = team_key(row.get("国家"))
    if key:
        market_value_by_key[key] = {
            "rank": num(row.get("排名")),
            "totalValueM": num(row.get("总身价(百万€)")),
            "avgValueM": num(row.get("平均身价")),
            "topPlayer": text(row.get("最高身价球员")),
            "topPlayerValueM": num(row.get("最高身价")),
            "status": text(row.get("数据状态")),
        }

group_outlook_by_key = {}
for row in group_rows:
    key = team_key(row.get("球队"))
    if key:
        group_outlook_by_key[key] = {
            "group": group_id(row.get("小组")),
            "projectedRank": num(row.get("排名")),
            "projectedPoints": num(row.get("积分")),
            "wins": num(row.get("胜")),
            "draws": num(row.get("平")),
            "losses": num(row.get("负")),
            "goalsFor": num(row.get("进球")),
            "goalsAgainst": num(row.get("失球")),
            "goalDiff": num(row.get("净胜球")),
            "advanceProbability": num(row.get("出线概率")),
            "groupWinProbability": num(row.get("小组第一概率")),
        }

raw_strength_by_key = {}
for row in raw_strength_rows:
    key = team_key(row.get("球队"))
    if key:
        raw_strength_by_key[key] = {
            "fifaRank": num(row.get("FIFA排名")),
            "elo": num(row.get("Elo评分")),
            "recent10Points": num(row.get("近10场积分")),
            "starterValueM": num(row.get("主力身价(百万€)")),
            "strengthScore": num(row.get("战力评分")),
            "championProbability": num(row.get("夺冠概率%")),
            "expectedGoals": num(row.get("预期进球xG")),
            "rating": text(row.get("评级")),
            "confidence": "audit-only",
        }

raw_group_by_key = {}
for row in raw_group_rows:
    key = team_key(row.get("球队"))
    if key:
        raw_group_by_key[key] = {
            "group": group_id(row.get("小组")),
            "firstProbability": num(row.get("第1概率%")),
            "secondProbability": num(row.get("第2概率%")),
            "thirdProbability": num(row.get("第3概率%")),
            "fourthProbability": num(row.get("第4概率%")),
            "advanceProbability": num(row.get("出线概率%")),
            "deathIndex": num(row.get("死亡指数")),
            "note": text(row.get("备注")),
            "confidence": "audit-only",
        }

players_by_key = defaultdict(list)
for row in player_rows:
    key = team_key(row.get("国籍"))
    if not key:
        continue
    players_by_key[key].append({
        "name": text(row.get("姓名")),
        "country": text(row.get("国籍")),
        "group": group_id(row.get("小组")),
        "confederation": text(row.get("大洲")),
        "position": text(row.get("位置")),
        "age": num(row.get("年龄")),
        "heightCm": num(row.get("身高(cm)")),
        "caps": num(row.get("出场")),
        "goals": num(row.get("进球")),
        "club": text(row.get("俱乐部")),
        "league": text(row.get("联赛")),
        "marketValueM": num(row.get("身价(百万€)")),
        "status": text(row.get("数据状态")),
    })

fifa_values = [num(row.get("FIFA排名")) for row in curated_team_rows if num(row.get("FIFA排名"))]
elo_values = [num(row.get("Elo评分")) for row in curated_team_rows if num(row.get("Elo评分"))]
value_values = [num(row.get("阵容身价(百万€)")) for row in curated_team_rows if num(row.get("阵容身价(百万€)"))]
min_elo, max_elo = min(elo_values), max(elo_values)
max_log_value = max(math.log10(v + 1) for v in value_values)

def clamp(value, lo, hi):
    return max(lo, min(hi, value))

def model_strength(row):
    fifa = num(row.get("FIFA排名"))
    elo = num(row.get("Elo评分"))
    value = num(row.get("阵容身价(百万€)"))
    form = parse_recent_form(row.get("近10场战绩"))
    rank_norm = 1 - ((fifa or 90) - 1) / 139
    elo_norm = ((elo or min_elo) - min_elo) / max(1, max_elo - min_elo)
    value_norm = math.log10((value or 0) + 1) / max_log_value
    form_norm = (form.get("points") if form.get("points") is not None else 12) / 30
    score = 0.36 * rank_norm + 0.34 * elo_norm + 0.18 * value_norm + 0.12 * form_norm
    return round(clamp(score, 0.18, 0.96), 4)

teams = []
for row in curated_team_rows:
    country = text(row.get("国家"))
    key = team_key(country)
    if not key:
        continue
    players = players_by_key.get(key, [])
    top_players = sorted(players, key=lambda p: p.get("marketValueM") or 0, reverse=True)[:5]
    status = text(row.get("数据状态"))
    teams.append({
        "key": key,
        "nameZh": country,
        "nameEn": KEY_TO_EN.get(key, country),
        "group": group_id(row.get("小组")),
        "confederation": text(row.get("大洲")),
        "fifaRank": num(row.get("FIFA排名")),
        "elo": num(row.get("Elo评分")),
        "squadValueM": num(row.get("阵容身价(百万€)")),
        "playerCount": num(row.get("球员数")),
        "avgAge": num(row.get("平均年龄")),
        "corePlayer": text(row.get("核心球员")),
        "recent10": parse_recent_form(row.get("近10场战绩")),
        "dataStatus": status,
        "qualityTier": "verified" if "已核实" in status else "estimated",
        "positionProfile": position_by_key.get(key),
        "marketValue": market_value_by_key.get(key),
        "groupOutlook": group_outlook_by_key.get(key),
        "rawStrength": raw_strength_by_key.get(key),
        "rawGroupOutlook": raw_group_by_key.get(key),
        "modelStrengthNormalized": model_strength(row),
        "topPlayers": top_players,
        "playerSummary": {
            "rows": len(players),
            "verifiedRows": sum(1 for p in players if "已核实" in p.get("status", "")),
            "estimatedRows": sum(1 for p in players if "预估" in p.get("status", "")),
            "leagueCount": len(set(p.get("league") for p in players if p.get("league"))),
        },
})

team_name_by_key = {team["key"]: team.get("nameZh") for team in teams}
players = sorted([
    {
        **player,
        "teamKey": key,
        "teamNameZh": team_name_by_key.get(key) or player.get("country"),
        "teamNameEn": KEY_TO_EN.get(key, player.get("country")),
    }
    for key, rows in players_by_key.items()
    for player in rows
], key=lambda p: (p.get("teamKey") or "", p.get("position") or "", p.get("name") or ""))

fixtures = []
for row in fixture_rows:
    match_no = num(row.get("场次"))
    home = text(row.get("主队"))
    away = text(row.get("客队"))
    if not match_no or not home or not away:
        continue
    kickoff_label = text(row.get("北京时间"))
    fixtures.append({
        "matchNo": match_no,
        "kickoffLabel": kickoff_label,
        "kickoffTime": parse_kickoff(kickoff_label),
        "homeKey": team_key(home),
        "awayKey": team_key(away),
        "homeNameZh": home,
        "awayNameZh": away,
        "venue": text(row.get("球场")),
        "city": text(row.get("城市")),
        "stage": text(row.get("阶段")),
        "group": group_id(row.get("小组")),
        "sourceQuality": "fallback-unreconciled",
        "note": "Use only when official Sporttery/FIFA fixture data is unavailable.",
    })

golden_boot = []
for row in scorer_rows:
    rank = num(row.get("排名"))
    name = text(row.get("姓名")).lstrip("★ ").strip()
    country = text(row.get("国籍"))
    if rank and name:
        golden_boot.append({
            "rank": rank,
            "name": name,
            "country": country,
            "countryKey": team_key(country),
            "position": text(row.get("位置")),
            "age": num(row.get("年龄")),
            "club": text(row.get("俱乐部")),
            "nationalGoals": num(row.get("国家队进球")),
            "nationalCaps": num(row.get("国家队出场")),
            "goalRate": num(row.get("进球率")),
            "xg90": num(row.get("xG/90")),
            "expectedAppearances": num(row.get("预期出场")),
            "projectedGoals": num(row.get("预测总进球")),
            "status": text(row.get("数据状态")),
        })

raw_top50_goalkeepers = 0
if raw_wb is not None and "身价榜与金靴预测" in raw_wb.sheetnames:
    for row in rows_from(raw_wb["身价榜与金靴预测"], 4):
        if text(row.get("位置")) == "门将":
            raw_top50_goalkeepers += 1

verified_teams = sum(1 for team in teams if team["qualityTier"] == "verified")
estimated_teams = len(teams) - verified_teams
dataset = {
    "version": "kimi-worldcup-dataset-v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "source": {
        "zipFile": zip_path.name,
        "zipSha256": zip_hash,
        "curatedWorkbook": curated_name,
        "rawWorkbook": raw_name or None,
    },
    "signature": f"kimi-worldcup-dataset-v1|{zip_hash[:16]}|teams:{len(teams)}|fixtures:{len(fixtures)}",
    "quality": {
        "curated": {
            "policy": "usable-as-pre-match-prior",
            "teams": len(teams),
            "fixtures": len(fixtures),
            "players": len(player_rows),
            "verifiedTeams": verified_teams,
            "estimatedTeams": estimated_teams,
            "note": "阵容、Elo、FIFA排名、身价和小组形势可作为世界杯赛前先验；赛程仅作 fallback，不覆盖官方源。",
        },
        "raw": {
            "policy": "audit-only",
            "teams": len(raw_strength_rows),
            "players": len(raw_player_rows),
            "fixtures": len(raw_fixture_rows),
            "top50Goalkeepers": raw_top50_goalkeepers,
            "note": "test_raw 字段更丰富但含生成/测试迹象，默认不进入模型权重，只保留审计和对比。",
        },
    },
    "teams": sorted(teams, key=lambda t: (t.get("group") or "", t.get("fifaRank") or 999, t.get("nameZh") or "")),
    "fixtures": fixtures,
    "players": players,
    "goldenBoot": golden_boot,
    "distributions": {
        "leagues": [
            {
                "league": text(row.get("联赛")),
                "players": num(row.get("球员人数")),
                "sharePct": num(row.get("占比(%)")),
                "totalValueM": num(row.get("总身价(百万€)")),
                "avgValueM": num(row.get("平均身价(百万€)")),
                "confederation": text(row.get("所属大洲")),
            }
            for row in league_rows if text(row.get("联赛"))
        ],
        "ages": [
            {
                "bucket": text(row.get("年龄段")),
                "players": num(row.get("人数")),
                "sharePct": num(row.get("占比(%)")),
                "avgValueM": num(row.get("平均身价(百万€)")),
                "topPlayer": text(row.get("最高身价球员")),
                "topValueM": num(row.get("最高身价")),
            }
            for row in age_rows if text(row.get("年龄段"))
        ],
    },
}

print(json.dumps(dataset, ensure_ascii=False, separators=(",", ":")))
`;

const tempScript = path.join(os.tmpdir(), `kimi-worldcup-import-${Date.now()}.py`);
fs.writeFileSync(tempScript, pySource, "utf8");

const result = spawnSync(python, [tempScript, zipPath, zipHash], {
  cwd: rootDir,
  env: {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
  },
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 64,
});
fs.rmSync(tempScript, { force: true });

if (result.error || result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.error(result.error?.message || `Python import failed with status ${result.status}`);
  process.exit(result.status || 1);
}

const dataset = JSON.parse(result.stdout);
const fullJsonPath = path.join(outputDir, "kimi-worldcup-dataset.json");
const publicJsonPath = path.join(publicDataDir, "worldcup-kimi-dataset.json");

const compactDataset = {
  version: dataset.version,
  generatedAt: dataset.generatedAt,
  source: dataset.source,
  signature: dataset.signature,
  quality: dataset.quality,
  teams: dataset.teams.map((team) => ({
    key: team.key,
    nameZh: team.nameZh,
    nameEn: team.nameEn,
    group: team.group,
    confederation: team.confederation,
    fifaRank: team.fifaRank,
    elo: team.elo,
    squadValueM: team.squadValueM,
    playerCount: team.playerCount,
    avgAge: team.avgAge,
    corePlayer: team.corePlayer,
    recent10: team.recent10,
    qualityTier: team.qualityTier,
    modelStrengthNormalized: team.modelStrengthNormalized,
    positionProfile: team.positionProfile,
    groupOutlook: team.groupOutlook,
    rawStrength: team.rawStrength,
    rawGroupOutlook: team.rawGroupOutlook,
    topPlayers: team.topPlayers,
  })),
  fixtures: dataset.fixtures,
  goldenBoot: dataset.goldenBoot.slice(0, 30),
  distributions: dataset.distributions,
};

fs.writeFileSync(fullJsonPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
fs.writeFileSync(publicJsonPath, `${JSON.stringify(compactDataset, null, 2)}\n`, "utf8");

const tsSource = `// Generated by scripts/importKimiWorldCupData.cjs. Do not edit by hand.\n\n` +
`export type KimiWorldCupTeamProfile = {\n` +
`  key: string;\n  nameZh: string;\n  nameEn: string;\n  group: string;\n  confederation: string;\n  fifaRank: number | null;\n  elo: number | null;\n  squadValueM: number | null;\n  playerCount: number | null;\n  avgAge: number | null;\n  corePlayer: string;\n  qualityTier: string;\n  modelStrengthNormalized: number;\n  recent10?: { raw: string; wins: number | null; draws: number | null; losses: number | null; points: number | null };\n  groupOutlook?: { projectedRank?: number | null; projectedPoints?: number | null; advanceProbability?: number | null; groupWinProbability?: number | null } | null;\n  rawStrength?: Record<string, unknown> | null;\n  rawGroupOutlook?: Record<string, unknown> | null;\n};\n\n` +
`export type KimiWorldCupFixtureSeed = {\n` +
`  matchNo: number;\n  kickoffLabel: string;\n  kickoffTime: string | null;\n  homeKey: string;\n  awayKey: string;\n  homeNameZh: string;\n  awayNameZh: string;\n  venue: string;\n  city: string;\n  stage: string;\n  group: string;\n  sourceQuality: string;\n  note: string;\n};\n\n` +
`export const KIMI_WORLD_CUP_DATASET = ${JSON.stringify(compactDataset, null, 2)} as const;\n\n` +
`const normalizeKimiKey = (value?: string) => String(value || '')\n` +
`  .trim()\n  .toLowerCase()\n  .normalize('NFKD')\n  .replace(/[\\u0300-\\u036f]/g, '')\n  .replace(/&/g, ' and ')\n  .replace(/[^a-z0-9\\u4e00-\\u9fff]+/g, '-')\n  .replace(/^-+|-+$/g, '');\n\n` +
`const TEAM_BY_KEY = new Map<string, KimiWorldCupTeamProfile>();\n` +
`KIMI_WORLD_CUP_DATASET.teams.forEach((team) => {\n` +
`  const profile = team as KimiWorldCupTeamProfile;\n` +
`  [profile.key, profile.nameZh, profile.nameEn].forEach((value) => TEAM_BY_KEY.set(normalizeKimiKey(value), profile));\n` +
`});\n\n` +
`export const getKimiWorldCupTeamProfile = (value?: string): KimiWorldCupTeamProfile | null => {\n` +
`  const key = normalizeKimiKey(value);\n` +
`  return TEAM_BY_KEY.get(key) || null;\n` +
`};\n\n` +
`export const getKimiWorldCupFixtureSeeds = (): KimiWorldCupFixtureSeed[] => (\n` +
`  KIMI_WORLD_CUP_DATASET.fixtures as unknown as KimiWorldCupFixtureSeed[]\n` +
`);\n`;

fs.writeFileSync(srcDataFile, tsSource, "utf8");

console.log(JSON.stringify({
  ok: true,
  zip: zipPath,
  fullJson: path.relative(rootDir, fullJsonPath),
  publicJson: path.relative(rootDir, publicJsonPath),
  tsModule: path.relative(rootDir, srcDataFile),
  teams: dataset.teams.length,
  fixtures: dataset.fixtures.length,
  players: dataset.quality.curated.players,
  signature: dataset.signature,
  rawPolicy: dataset.quality.raw.policy,
}, null, 2));
