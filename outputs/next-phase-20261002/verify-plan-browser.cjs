"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),{pathToFileURL}=require("node:url");
const {chromium}=require("C:/Users/86188/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
(async()=>{const browser=await chromium.launch({channel:"chrome",headless:true});const checks=[];try{
  for(const width of [390,1440]){const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(pathToFileURL(path.join(__dirname,"implementation-plan.html")).href);
    const state=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,title:document.title,phases:document.querySelectorAll(".phase").length}));
    assert.ok(state.scroll<=state.width);assert.equal(state.phases,4);assert.equal(errors.length,0);
    await page.screenshot({path:path.join(__dirname,`plan-${width}.png`)});checks.push({...state,errors});await page.close();}
}finally{await browser.close();}fs.writeFileSync(path.join(__dirname,"plan-browser-verification.json"),JSON.stringify({verifiedAt:new Date().toISOString(),checks},null,2)+"\n");console.log(JSON.stringify({ok:true,checks:checks.length}));})().catch(e=>{console.error(e);process.exitCode=1;});
