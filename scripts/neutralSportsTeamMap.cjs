'use strict';
const pairs = [
 ['PL',[2,'阿斯顿维拉',58,'Aston Villa FC'],[12,'曼彻斯特城',65,'Manchester City FC']],
 ['ELC',[6,'查尔顿',348,'Charlton Athletic FC'],[16,'诺维奇',68,'Norwich City FC']],
 ['PD',[849,'巴列卡诺',87,'Rayo Vallecano de Madrid'],[30,'埃尔切',285,'Elche CF']],
 ['SA',[1040070,'科莫',7397,'Como 1907'],[1509,'萨索洛',471,'US Sassuolo Calcio']],
 ['SA',[120,'卡利亚里',104,'Cagliari Calcio'],[118,'博洛尼亚',103,'Bologna FC 1909']],
 ['BL1',[1619,'莱比锡红牛',721,'RB Leipzig'],[2194,'埃尔沃斯堡',719,'SV 07 Elversberg']],
 ['BL1',[147,'美因茨',15,'1. FSV Mainz 05'],[153,'云达不来梅',12,'SV Werder Bremen']],
 ['BL1',[169,'帕德博恩',29,'SC Paderborn 07'],[142,'汉堡',7,'Hamburger SV']],
 ['BL1',[166,'科隆',1,'1. FC Köln'],[151,'沙尔克04',6,'FC Schalke 04']],
 ['BL1',[808,'奥格斯堡',16,'FC Augsburg'],[1270,'柏林联合',28,'1. FC Union Berlin']],
 ['PL',[1,'阿森纳',57,'Arsenal FC'],[9,'埃弗顿',62,'Everton FC']],
 ['PL',[44,'考文垂',1076,'Coventry City FC'],[10,'富勒姆',63,'Fulham FC']],
 ['PD',[676,'桑坦德竞技',5335,'Real Racing Club de Santander'],[510,'西班牙人',80,'RCD Espanyol de Barcelona']],
 ['DED',[255,'乌德勒支',676,'FC Utrecht'],[537,'兹沃勒',684,'PEC Zwolle']],
 ['PPL',[261,'阿马多拉',9136,'CF Estrela da Amadora'],[2702,'卡萨皮亚',6618,'Casa Pia AC']],
 ['SA',[744,'那不勒斯',113,'SSC Napoli'],[132,'罗马',100,'AS Roma']],
 ['PL',[7,'切尔西',61,'Chelsea FC'],[19,'托特纳姆热刺',73,'Tottenham Hotspur FC']],
 ['BL1',[140,'多特蒙德',4,'Borussia Dortmund'],[170,'法兰克福',19,'Eintracht Frankfurt']],
 ['PD',[678,'巴伦西亚',95,'Valencia CF'],[679,'比利亚雷亚尔',94,'Villarreal CF']],
 ['SA',[125,'拉齐奥',110,'SS Lazio'],[130,'帕尔马',112,'Parma Calcio 1913']],
 ['FL1',[179,'朗斯',546,'Racing Club de Lens'],[482,'巴黎FC',1045,'Paris FC']],
 ['PD',[172,'马德里竞技',78,'Club Atlético de Madrid'],[509,'拉科鲁尼亚',560,'RC Deportivo La Coruña']],
 ['PPL',[393,'吉维森特',5533,'Gil Vicente FC'],[937,'波尔图',503,'FC Porto']],
 ['BSA',[581,'桑托斯',6685,'Santos FC'],[1558,'巴伊亚',1777,'EC Bahia']],
];
const additional = [
 ['DED',[1474,'福图纳锡塔德',1920,'Fortuna Sittard'],[816,'SBV精英',670,'SBV Excelsior']],
 ['DED',[250,'PSV埃因霍温',674,'PSV'],[245,'费耶诺德',675,'Feyenoord Rotterdam']],
 ['DED',[241,'阿尔克马尔',682,'AZ'],[254,'特温特',666,"FC Twente '65"]],
 ['PL',[76,'赫尔城',322,'Hull City AFC'],[69,'布伦特福德',402,'Brentford FC']],
 ['PL',[8,'水晶宫',354,'Crystal Palace FC'],[15,'纽卡斯尔联',67,'Newcastle United FC']],
 ['PL',[13,'曼彻斯特联',66,'Manchester United FC'],[67,'伯恩茅斯',1044,'AFC Bournemouth']],
 ['PL',[60,'桑德兰',71,'Sunderland AFC'],[49,'利兹联',341,'Leeds United FC']],
 ['SA',[123,'国际米兰',108,'FC Internazionale Milano'],[122,'佛罗伦萨',99,'ACF Fiorentina']],
 ['SA',[26,'热那亚',107,'Genoa CFC'],[1029209,'威尼斯',454,'Venezia FC']],
 ['SA',[117,'亚特兰大',102,'Atalanta BC'],[1303,'弗洛西诺内',470,'Frosinone Calcio']],
 ['SA',[126,'莱切',5890,'US Lecce'],[124,'尤文图斯',109,'Juventus FC']],
 ['SA',[135,'乌迪内斯',115,'Udinese Calcio'],[116,'AC米兰',98,'AC Milan']],
 ['PD',[506,'毕尔巴鄂竞技',77,'Athletic Club'],[511,'赫塔费',82,'Getafe CF']],
 ['PD',[508,'维戈塞尔塔',558,'RC Celta de Vigo'],[505,'皇家贝蒂斯',90,'Real Betis Balompié']],
 ['PD',[675,'皇家社会',92,'Real Sociedad de Fútbol'],[33,'莱万特',88,'Levante UD']],
 ['PD',[401,'巴塞罗那',81,'FC Barcelona'],[664,'皇家马德里',86,'Real Madrid CF']],
 ['PD',[677,'塞维利亚',559,'Sevilla FC'],[534,'奥萨苏纳',79,'CA Osasuna']],
 ['FL1',[184,'摩纳哥',548,'AS Monaco FC'],[180,'里尔',521,'Lille OSC']],
 ['FL1',[188,'雷恩',529,'Stade Rennais FC 1901'],[191,'斯特拉斯堡',576,'RC Strasbourg Alsace']],
 ['BL1',[158,'霍芬海姆',2,'TSG 1899 Hoffenheim'],[146,'勒沃库森',3,'Bayer 04 Leverkusen']],
 ['BL1',[141,'弗赖堡',17,'SC Freiburg'],[137,'拜仁慕尼黑',5,'FC Bayern München']],
 ['PPL',[1060,'里斯本竞技',498,'Sporting Clube de Portugal'],[1872,'维塞乌',5527,'Académico de Viseu FC']],
 ['PPL',[1618,'圣克拉拉',5530,'CD Santa Clara'],[267,'本菲卡',1903,'Sport Lisboa e Benfica']],
 ['BSA',[571,'弗拉门戈',1783,'CR Flamengo'],[563,'米内罗竞技',1766,'CA Mineiro']],
];
const leagues = { PL:'英格兰超级联赛', ELC:'英格兰冠军联赛', PD:'西班牙甲级联赛', SA:'意大利甲级联赛', BL1:'德国甲级联赛', DED:'荷兰甲级联赛', PPL:'葡萄牙超级联赛', FL1:'法国甲级联赛', BSA:'巴西甲级联赛' };
function resolve(event) {
  const code = Object.keys(leagues).find(key => leagues[key] === event.leagueName);
  if (!code) return null;
  const teams = [event.homeTeamId, event.awayTeamId].map((id, index) => {
    const name = index ? event.awayTeamName : event.homeTeamName;
    const candidates = [...pairs,...additional].filter(pair => pair[0] === code).flatMap(pair => pair.slice(1)).filter(team => team[0] === id && team[1] === name);
    return candidates.length === 1 ? candidates[0] : null;
  });
  return teams.every(Boolean) ? { code, teams, independentlyVerified: false } : null;
}
module.exports = { pairs, leagues, resolve };
