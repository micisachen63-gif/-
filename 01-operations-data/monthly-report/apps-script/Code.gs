/**
 * 月報簡報 uploader (standalone Apps Script web app, Execute as: Me, Who has access: Anyone).
 *
 * Every request: POST JSON {secret, action, ...}. The secret is compared with Script Property
 * DECK_SECRET; anything else gets {ok:false,error:"unauthorized"}.
 * Scopes: drive (find/copy last month's deck in the folder) + presentations (edit slides).
 * Images arrive as base64 in the request and are used as in-memory blobs only (no Drive temp files).
 *
 * Safety:
 *  - only decks inside ALLOWED_FOLDER (Script Property, default below) are touched;
 *  - slides can only be changed on decks registered by `prepare` (this month's copy), never on the
 *    source deck;
 *  - test mode prefixes the title with "[測試] " so it can never reuse/overwrite the real deck.
 */
var DEFAULT_FOLDER = '1Ua-ZQH_7XkzLg9P1HlayF_7R_BZzAZLH';
var TEST_PREFIX = '[測試] ';
var VERSION = '2026-10-01c';

/** Run once from the editor to grant access (Drive folder + Slides). */
function authorize() {
  var f = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('ALLOWED_FOLDER') || DEFAULT_FOLDER);
  Logger.log('OK: ' + f.getName() + ' / secret set: ' + ((PropertiesService.getScriptProperties().getProperty('DECK_SECRET') || '').length >= 32));
  SlidesApp.getActivePresentation; // presentations scope is declared in appsscript.json
}

function doGet() { return out_({ok: false, error: 'POST only'}); }

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out_({ok: false, error: 'bad json'}); }
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('DECK_SECRET') || '';
  if (secret.length < 32 || !same_(String(req.secret || ''), secret)) return out_({ok: false, error: 'unauthorized'});
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(300000)) return out_({ok: false, error: 'busy'});
  try {
    var folderId = props.getProperty('ALLOWED_FOLDER') || DEFAULT_FOLDER;
    var fn = ACTIONS[req.action];
    if (!fn) return out_({ok: false, error: 'unknown action'});
    var result = fn(req, folderId, props);
    result.ok = true;
    return out_(result);
  } catch (err) {
    return out_({ok: false, error: String(err && err.message || err)});
  } finally {
    lock.releaseLock();
  }
}

var ACTIONS = {
  ping: function () { return {version: VERSION, time: new Date().toISOString()}; },

  /** Read-only: is this month's deck there, which source deck would be copied, how are its slides built. */
  lookup: function (req, folderId) {
    checkFolder_(req, folderId);
    var title = titleFor_(req);
    var existing = findByTitle_(folderId, title);
    var src = existing ? null : findSource_(req, folderId);
    var target = existing || src;
    return {title: title, existingId: existing ? existing.getId() : null, sourceId: src ? src.getId() : null,
      sourceName: src ? src.getName() : null, slides: target ? describe_(SlidesApp.openById(target.getId())) : []};
  },

  /** Copy last month's deck to the new title (or reuse a deck that already has the new title). */
  prepare: function (req, folderId, props) {
    checkFolder_(req, folderId);
    var title = titleFor_(req);
    var file = findByTitle_(folderId, title), reused = !!file;
    if (!file) {
      var src = findSource_(req, folderId);
      if (!src) throw new Error('source deck not found in folder: ' + JSON.stringify(req.sourceTitles || req.sourceTitle || req.sourceId));
      file = src.makeCopy(title, DriveApp.getFolderById(folderId));
    }
    register_(props, file.getId());
    var p = SlidesApp.openById(file.getId());
    return {deckId: file.getId(), title: title, reused: reused, slideCount: p.getSlides().length, url: p.getUrl()};
  },

  /** Replace the picture of slide `index` (1-based) in place. */
  putSlide: function (req, folderId, props) {
    var p = openRegistered_(req.deckId, folderId, props);
    var slides = p.getSlides(), i = Number(req.index);
    if (!(i >= 1 && i <= slides.length)) throw new Error('slide ' + req.index + ' does not exist (deck has ' + slides.length + ')');
    var how = place_(p, slides[i - 1], blob_(req), req.mode);
    p.saveAndClose();
    return {index: i, how: how};
  },

  /** 茄子 first run: duplicate slide `sourceIndex`, move it to position `index` (= end), then replace. Idempotent. */
  appendSlide: function (req, folderId, props) {
    var p = openRegistered_(req.deckId, folderId, props);
    var slides = p.getSlides(), i = Number(req.index), s = Number(req.sourceIndex);
    if (i <= slides.length) { // already there (re-run): just replace
      var how0 = place_(p, slides[i - 1], blob_(req), req.mode);
      p.saveAndClose();
      return {index: i, how: how0, appended: false};
    }
    if (i !== slides.length + 1) throw new Error('append out of order: deck has ' + slides.length + ' slides, asked for ' + i);
    if (!(s >= 1 && s <= slides.length)) throw new Error('source slide ' + s + ' does not exist');
    var dup = slides[s - 1].duplicate();
    dup.move(p.getSlides().length - 1); // 0-based: last position
    var how = place_(p, dup, blob_(req), req.mode);
    p.saveAndClose();
    return {index: i, how: how, appended: true};
  },

  /** Read-only: file name / last change / slide count of a deck in the folder. */
  info: function (req, folderId) {
    var f = folderFile_(req.fileId, folderId), p = SlidesApp.openById(f.getId());
    return {name: f.getName(), lastUpdated: f.getLastUpdated().toISOString(), slideCount: p.getSlides().length, url: p.getUrl()};
  },

  /** Read-only: thumbnail of slide `index` (Slides API via the advanced service). contentUrl lives ~30 min. */
  thumbnail: function (req, folderId) {
    var f = folderFile_(req.fileId, folderId), slides = SlidesApp.openById(f.getId()).getSlides(), i = Number(req.index);
    if (!(i >= 1 && i <= slides.length)) throw new Error('slide ' + req.index + ' does not exist');
    var t = Slides.Presentations.Pages.getThumbnail(f.getId(), slides[i - 1].getObjectId(),
      {'thumbnailProperties.thumbnailSize': req.size === 'LARGE' ? 'LARGE' : req.size === 'SMALL' ? 'SMALL' : 'MEDIUM', 'thumbnailProperties.mimeType': 'PNG'});
    return {index: i, contentUrl: t.contentUrl, width: t.width, height: t.height};
  },

  finish: function (req, folderId, props) {
    var p = openRegistered_(req.deckId, folderId, props);
    return {url: p.getUrl(), title: p.getName(), slideCount: p.getSlides().length};
  },
};

// ---------- helpers ----------
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function same_(a, b) { // length-independent comparison
  var d = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) d |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ b.charCodeAt(i);
  return d === 0;
}

function checkFolder_(req, folderId) {
  if (req.folderId && req.folderId !== folderId) throw new Error('folder not allowed');
}

function titleFor_(req) {
  var t = String(req.title || '').trim();
  if (!t) throw new Error('title missing');
  if (t.indexOf(TEST_PREFIX) === 0) t = t.slice(TEST_PREFIX.length);
  return req.test ? TEST_PREFIX + t : t;
}

function slidesFiles_(folderId) {
  var it = DriveApp.getFolderById(folderId).getFilesByType(MimeType.GOOGLE_SLIDES), list = [];
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) list.push(f); }
  return list;
}

function findByTitle_(folderId, title) {
  var hits = slidesFiles_(folderId).filter(function (f) { return f.getName() === title; });
  hits.sort(function (a, b) { return b.getLastUpdated() - a.getLastUpdated(); });
  return hits[0] || null;
}

function findSource_(req, folderId) {
  if (req.sourceId) {
    var f = DriveApp.getFileById(req.sourceId);
    if (!inFolder_(f, folderId)) throw new Error('source deck is not in the allowed folder');
    return f;
  }
  var names = [].concat(req.sourceTitles || [], req.sourceTitle ? [req.sourceTitle] : []);
  for (var i = 0; i < names.length; i++) { var hit = findByTitle_(folderId, names[i]); if (hit) return hit; }
  return null;
}

function inFolder_(file, folderId) {
  var it = file.getParents();
  while (it.hasNext()) if (it.next().getId() === folderId) return true;
  return false;
}

function folderFile_(id, folderId) {
  if (!id) throw new Error('fileId missing');
  var f = DriveApp.getFileById(id);
  if (!inFolder_(f, folderId) || f.getMimeType() !== MimeType.GOOGLE_SLIDES) throw new Error('not a deck in the allowed folder');
  return f;
}

function register_(props, id) {
  var list = JSON.parse(props.getProperty('DECKS') || '[]').filter(function (x) { return x !== id; });
  list.push(id);
  props.setProperty('DECKS', JSON.stringify(list.slice(-24)));
}

function openRegistered_(deckId, folderId, props) {
  var list = JSON.parse(props.getProperty('DECKS') || '[]');
  if (!deckId || list.indexOf(deckId) < 0) throw new Error('deck was not prepared by this script');
  if (!inFolder_(DriveApp.getFileById(deckId), folderId)) throw new Error('deck is not in the allowed folder');
  return SlidesApp.openById(deckId);
}

function blob_(req) {
  if (!req.pngBase64) throw new Error('pngBase64 missing');
  return Utilities.newBlob(Utilities.base64Decode(req.pngBase64), 'image/png', 'slide-' + req.index + '.png');
}

function bigImage_(p, slide) {
  var page = p.getPageWidth() * p.getPageHeight(), best = null, area = 0;
  slide.getImages().forEach(function (im) { var a = im.getWidth() * im.getHeight(); if (a > area) { area = a; best = im; } });
  return {image: best, coverage: page ? area / page : 0};
}

/** Full-page picture element → replace it (same size and position); otherwise → page background picture. */
function place_(p, slide, blob, mode) {
  var big = bigImage_(p, slide);
  var useImage = mode === 'image' || (mode !== 'background' && big.image && big.coverage >= 0.8);
  if (useImage) {
    if (!big.image) throw new Error('no picture element on this slide');
    var im = big.image, box = {l: im.getLeft(), t: im.getTop(), w: im.getWidth(), h: im.getHeight()};
    var pw = p.getPageWidth(), ph = p.getPageHeight();
    // A full-page picture (>=95% of the page) is snapped to exactly the page, so an earlier
    // shrunken frame can't leave a white edge; smaller pictures keep their exact old frame.
    if (box.w * box.h >= 0.95 * pw * ph) box = {l: 0, t: 0, w: pw, h: ph};
    var ni = im.replace(blob, false) || im; // replace() fits inside the frame; set the frame explicitly
    ni.setLeft(box.l).setTop(box.t).setWidth(box.w).setHeight(box.h);
    return 'image';
  }
  slide.getBackground().setPictureFill(blob);
  return 'background';
}

function describe_(p) {
  return p.getSlides().map(function (s, i) {
    var big = bigImage_(p, s);
    return {index: i + 1, images: s.getImages().length, coverage: Math.round(big.coverage * 100) / 100,
      background: String(s.getBackground().getType()), elements: s.getPageElements().length,
      will: big.image && big.coverage >= 0.8 ? 'image' : 'background'};
  });
}
