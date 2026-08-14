#!/usr/bin/env node
// split-novels.js — 提交时把仓库根目录的「大 txt 小说」按章拆分为「目录 + 每章一个文件」，
// 并据此重写 manifest.json（书库清单）。这样既解决大文件加载慢，也避免整本塞进 localStorage 触发配额。
//
// 行为：
//  - 扫描根目录所有 .txt（脚本/清单文件除外）。
//  - 对每个 txt：用与网页一致的章节正则切分，输出 <书名>/toc.json + <书名>/NNN.txt（每章一个）。
//  - 拆分后删除原始大 txt（已跟踪 → git rm；未跟踪 → 直接删本地文件）。
//  - 幂等：若 <书名>/toc.json 已存在且源未变，跳过；源仍在但 hash 变化则重拆。
//  - 重写根 manifest.json 为 [{title, dir}]（拆分书）与 [{title, file}]（遗留单文件）两类条目。
//  - 把新增的目录与 manifest.json 暂存（不提交），交给用户 commit/push。
//
// 用法：node split-novels.js [repo根目录]   （缺省为当前目录）

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = process.argv[2] || process.cwd();

// 与网页阅读器保持一致的章节识别
const CHAPTER_RE = /^(?:\s*第\s*[0-9零一二三四五六七八九十百千两]+\s*[章卷回节部篇集]|Chapter\s+[0-9]+|序章|序言|前言|楔子|引子|后记|尾声|番外|附[录言])/i;

function isChapterTitle(line){
  if(!line) return false;
  const t = line.trim();
  if(t.length === 0 || t.length > 40) return false;
  return CHAPTER_RE.test(t);
}

function sanitize(name){
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}
function sha256(buf){ return crypto.createHash("sha256").update(buf).digest("hex"); }

// 源 txt 可能是 GBK/GB2312（很多小说下载站默认编码）。统一转成 UTF-8 再切分，避免乱码。
// 策略：先按 UTF-8 宽松解码；若出现替换符（说明不是合法 UTF-8），改按 GBK 解码，取无替换符的结果。
function decodeBest(buf){
  const asUtf8 = new TextDecoder("utf-8").decode(buf);
  if(asUtf8.indexOf("�") === -1) return asUtf8;          // 合法 UTF-8
  try {
    const asGbk = new TextDecoder("gbk").decode(buf);
    if(asGbk.indexOf("�") === -1) return asGbk;          // GBK 可完整解码
  } catch(e){ /* 不是 GBK，退回 */ }
  return asUtf8;                                          // 兜底：保留（可能乱码）
}

function parseChapters(text){
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let cur = null, buf = [];
  const flush = () => { if(cur !== null) chapters.push({ title: cur.title, content: buf.join("\n").trim() }); };
  for(const line of lines){
    if(isChapterTitle(line)){ flush(); cur = { title: line.trim() }; buf = []; }
    else { if(cur === null) cur = { title: "正文" }; buf.push(line); }
  }
  flush();
  if(chapters.length === 0) chapters.push({ title: "全文", content: text.trim() });
  return chapters;
}

function isTracked(rel){
  const r = spawnSync("git", ["ls-files", "--error-unmatch", rel], { cwd: ROOT, stdio: "ignore" });
  return r.status === 0;
}
function removeRaw(rel){
  const full = path.join(ROOT, rel);
  if(isTracked(rel)){
    const r = spawnSync("git", ["rm", "-q", rel], { cwd: ROOT, stdio: "inherit" });
    if(r.status !== 0) console.log("warning: git rm failed for " + rel + " (已尝试删除本地文件)");
  }
  if(fs.existsSync(full)){ try { fs.unlinkSync(full); } catch(e){ console.log("warning: 删除本地 " + rel + " 失败: " + e.message); } }
}

function splitOne(txtRel){
  const full = path.join(ROOT, txtRel);
    let buf;
    try { buf = fs.readFileSync(full); } catch(e){ console.log("skip (read fail): " + txtRel); return null; }
    const text = decodeBest(buf).replace(/^﻿/, "");
  const base = txtRel.replace(/\.txt$/i, "");
  const slug = sanitize(base);
  const dir = path.join(ROOT, slug);
  const tocPath = path.join(dir, "toc.json");
  const hash = sha256(buf);

  // 幂等：已拆分且源已不在 → 跳过；源还在且 hash 一致 → 跳过
  if(fs.existsSync(tocPath)){
    if(!fs.existsSync(full)){ console.log("skip (already split, source gone): " + slug); return null; }
    try {
      const old = JSON.parse(fs.readFileSync(tocPath, "utf8"));
      if(old.srcHash === hash){ console.log("skip (unchanged): " + slug); return null; }
    } catch(e){ /* toc 损坏，重新拆分 */ }
  }

  const chapters = parseChapters(text);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  else {
    // 重拆：清掉旧章节文件，避免残留
    for(const f of fs.readdirSync(dir)){
      if(/\.txt$/.test(f)){ try { fs.unlinkSync(path.join(dir, f)); } catch(e){} }
    }
  }
  const width = String(chapters.length).length;
  const entries = chapters.map((c, i) => {
    const n = String(i + 1).padStart(width, "0");
    const file = n + ".txt";
    fs.writeFileSync(path.join(dir, file), c.content + "\n", "utf8");
    return { n: i + 1, title: c.title, file };
  });
  const toc = { title: base, srcHash: hash, count: chapters.length, chapters: entries };
  fs.writeFileSync(tocPath, JSON.stringify(toc, null, 2), "utf8");
  console.log("split: " + base + " -> " + slug + "/ (" + chapters.length + " 章)");
  removeRaw(txtRel);
  return slug;
}

function regenManifest(){
  const books = [];
  for(const ent of fs.readdirSync(ROOT, { withFileTypes: true })){
    if(ent.isDirectory()){
      const toc = path.join(ROOT, ent.name, "toc.json");
      if(fs.existsSync(toc)){
        try { const t = JSON.parse(fs.readFileSync(toc, "utf8")); books.push({ title: t.title || ent.name, dir: ent.name }); } catch(e){}
      }
    }
  }
  for(const ent of fs.readdirSync(ROOT)){
    if(/\.txt$/i.test(ent) && ent !== "manifest.json"){
      const full = path.join(ROOT, ent);
      if(fs.statSync(full).isFile()) books.push({ title: ent.replace(/\.txt$/i, ""), file: ent });
    }
  }
  books.sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh"));
  fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(books, null, 2), "utf8");
  console.log("manifest.json: " + books.length + " 本书");
}

function main(){
  const ignore = new Set(["manifest.json", "gen-manifest.js", "split-novels.js", "README.md"]);
  const txts = fs.readdirSync(ROOT).filter(f =>
    /\.txt$/i.test(f) && fs.statSync(path.join(ROOT, f)).isFile() && !ignore.has(f)
  );
  let changed = 0;
  for(const f of txts){
    if(splitOne(f)) changed++;
  }
  regenManifest();
  if(changed > 0){
    for(const ent of fs.readdirSync(ROOT, { withFileTypes: true })){
      if(ent.isDirectory() && fs.existsSync(path.join(ROOT, ent.name, "toc.json"))){
        spawnSync("git", ["add", "-f", ent.name], { cwd: ROOT, stdio: "inherit" });
      }
    }
    spawnSync("git", ["add", "-f", "manifest.json"], { cwd: ROOT, stdio: "inherit" });
  }
  console.log("split-novels done." + (changed ? "" : " (无新书需拆分)"));
}
main();
