const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdminLogin, isLineLogin, isGoogleLogin } = require('./ensure-logins.cjs');

test('login pages are recognised by host and path, not by words hidden in the query string', () => {
  assert.equal(isLineLogin('https://account.line.biz/login?redirectUri=https%3A%2F%2Faccount.line.biz%2Foauth2%2Fcallback%3Fcode_challenge%3Dx'), true);
  assert.equal(isLineLogin('https://access.line.me/oauth2/v2.1/login?returnUri=%2Foauth2%3Fredirect_uri%3Dhttps%253A%252F%252Faccount.line.biz'), true);
  assert.equal(isLineLogin('https://manager.line.biz/account/@334ojgrp/broadcast'), false);
  assert.equal(isAdminLogin('https://admin.qzplays.com:9955/login?next=/gm/mail'), true);
  assert.equal(isAdminLogin('https://admin.qzplays.com:9955/#/login'), true);
  assert.equal(isAdminLogin('https://admin.qzplays.com:9955/player/list?from=/login'), false);
  assert.equal(isGoogleLogin('https://accounts.google.com/v3/signin/accountchooser?continue=https://docs.google.com'), true);
  assert.equal(isGoogleLogin('https://docs.google.com/spreadsheets/d/x/edit'), false);
});
