const kickoffISO = '2026-06-02T01:30:00+08:00';
console.log('Split Date:', kickoffISO.split('T')[0]);
const d = new Date(kickoffISO);
console.log('Date Object String:', d.toString());
console.log('Formatted Local Time:', d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }));
