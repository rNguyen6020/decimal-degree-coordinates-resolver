import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinate, ParseError } from '../src/index.js';

const EPS = 1e-6;

function approxEqual(a, b, eps = EPS) {
  assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);
}

test('parses simple decimal degrees with cardinals', () => {
  const r = parseCoordinate('48.8566 N, 2.3522 E');
  approxEqual(r.latitude, 48.8566);
  approxEqual(r.longitude, 2.3522);
});

test('parses full DMS with cardinals and seconds fraction', () => {
  const r = parseCoordinate('48 51 24.1 N 2 21 8.2 E');
  approxEqual(r.latitude, 48 + 51 / 60 + 24.1 / 3600);
  approxEqual(r.longitude, 2 + 21 / 60 + 8.2 / 3600);
});

test('parses signed decimal without cardinals', () => {
  const r = parseCoordinate('-48.8566 -2.3522');
  approxEqual(r.latitude, -48.8566);
  approxEqual(r.longitude, -2.3522);
});

test('parses array input', () => {
  const r = parseCoordinate(['33.9425 S', '18.8683 E']);
  approxEqual(r.latitude, -33.9425);
  approxEqual(r.longitude, 18.8683);
});

test('south cardinal overrides leading digits sign to negative', () => {
  const r = parseCoordinate('0 0 0 S 0 0 0 E');
  approxEqual(r.latitude, 0);
  approxEqual(r.longitude, 0);
});

test('handles unicode minus sign U+2212', () => {
  const r = parseCoordinate('\u221248.8566 \u22122.3522');
  approxEqual(r.latitude, -48.8566);
  approxEqual(r.longitude, -2.3522);
});

test('handles degree-minutes only', () => {
  const r = parseCoordinate('48 51.6 N, 2 21.5 E');
  approxEqual(r.latitude, 48 + 51.6 / 60);
  approxEqual(r.longitude, 2 + 21.5 / 60);
});

test('throws on contradictory sign and cardinal', () => {
  assert.throws(() => parseCoordinate('-48 N 2 E'), ParseError);
});

test('throws on minutes >= 60', () => {
  assert.throws(() => parseCoordinate('48 60 N 2 E'), ParseError);
});

test('throws on seconds >= 60', () => {
  assert.throws(() => parseCoordinate('48 30 60 N 2 E'), ParseError);
});

test('throws on latitude out of range', () => {
  assert.throws(() => parseCoordinate('95 N 2 E'), ParseError);
});

test('throws on longitude out of range', () => {
  assert.throws(() => parseCoordinate('48 N 200 E'), ParseError);
});

test('throws on empty string', () => {
  assert.throws(() => parseCoordinate(''), ParseError);
});

test('throws on trailing garbage', () => {
  assert.throws(() => parseCoordinate('48 N 2 E garbage'), ParseError);
});

test('throws on non-string non-array input', () => {
  assert.throws(() => parseCoordinate(42), ParseError);
});
