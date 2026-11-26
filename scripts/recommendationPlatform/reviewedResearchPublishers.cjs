'use strict';
module.exports=Object.freeze([
 {publisherId:'kleague-official',editorialGroup:'kleague',hosts:['kleague.com'],role:'official-league'},
 {publisherId:'jleague-official',editorialGroup:'jleague',hosts:['jleague.jp'],role:'official-league'},
 {publisherId:'aleagues-official',editorialGroup:'aleagues',hosts:['aleagues.com.au'],role:'official-league'},
 {publisherId:'api-football',editorialGroup:'api-sports',hosts:['api-football.com','api-sports.io'],role:'statistics'},
 {publisherId:'500',editorialGroup:'500',hosts:['500.com'],role:'statistics'},
].map(entry=>Object.freeze({...entry,hosts:Object.freeze(entry.hosts)})));
