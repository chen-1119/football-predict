"use strict";

// Full/short Sporttery names observed on the same source event in the archived
// official receipt and rebuilt history (2026-09-15). These aliases only repair
// name-derived presentation IDs during result reconciliation. Provider IDs,
// event times, source IDs, scores and frozen prediction evidence stay guarded.
const aliases = new Map([
  ["克拉约瓦", "克拉约瓦大学"], ["埃斯托里", "埃斯托里尔"],
  ["米堡", "米德尔斯堡"], ["雷克斯", "雷克斯汉姆"],
  ["巴竞技", "巴拉纳竞技"], ["弗鲁米嫩", "弗鲁米嫩塞"],
  ["达伽马", "瓦斯科达伽马"], ["格风暴", "格拉茨风暴"],
  ["塞萨洛", "塞萨洛尼基"], ["安德莱", "安德莱赫特"],
  ["比亚韦", "比亚韦斯托克"], ["流浪者", "格拉斯哥流浪者"],
  ["塞伊奈", "塞伊奈约基"], ["桑纳菲", "桑纳菲尤尔"],
  ["奥斯KFUM", "奥斯陆KFUM"],
]);
const knownNames = new Set([...aliases.keys(), ...aliases.values()]);
function derivedTeamId(name) {
  let hash = 2166136261;
  for (const character of String(name || "").split("")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `team_${(hash >>> 0).toString(36)}`;
}
function storedResultTeamIdentity(match) {
  const normalized = { ...match };
  for (const side of ["home", "away"]) {
    const name = match?.[`${side}TeamName`];
    // An actual provider/team ID must not be replaced by a display-name alias.
    if (!knownNames.has(name) || match?.[`${side}TeamId`] !== derivedTeamId(name)) continue;
    normalized[`${side}TeamId`] = derivedTeamId(aliases.get(name) || name);
  }
  return normalized;
}
module.exports = { storedResultTeamIdentity, derivedTeamId };
