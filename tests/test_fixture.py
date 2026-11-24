"""Offline HTTP contract tests for the static AniKatha fixture (stdlib only)."""
import ipaddress
import json
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

from scripts.serve import Handler, Server

ROOT = Path(__file__).resolve().parent.parent
PREFIX = '/anikatha/'
LIMIT = 256 * 1024


class FixtureContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def get(self, path, expected=200):
        conn = HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=5)
        try:
            conn.request('GET', path)
            response = conn.getresponse()
            body = response.read()
            self.assertEqual(response.status, expected, path)
            self.assertLessEqual(len(body), LIMIT, path)
            if expected == 200:
                self.assertEqual(response.getheader('Access-Control-Allow-Origin'), '*')
                self.assertEqual(response.getheader('Content-Type').split(';')[0], 'application/json')
                return json.loads(body)
        finally:
            conn.close()

    def test_catalog_meta_episode_stream_chain(self):
        manifest = self.get(PREFIX + 'manifest.json')
        self.assertEqual(manifest['anikathaProtocolVersion'], 1)
        self.assertTrue(manifest['id'])
        self.assertEqual(manifest['types'], ['anime'])
        self.assertEqual(set(manifest['resources']), {'catalog', 'meta', 'stream'})
        self.assertTrue(manifest['catalogs'])
        for catalog in manifest['catalogs']:
            self.assertEqual(catalog['type'], 'anime')
            metas = self.get(f"{PREFIX}catalog/anime/{catalog['id']}.json")['metas']
            self.assertTrue(metas)
            for item in metas:
                self.assertEqual(item['type'], 'anime')
                self.assertTrue(item['id'] and item['name'])
                meta = self.get(f"{PREFIX}meta/anime/{item['id']}.json")['meta']
                self.assertEqual(meta['id'], item['id'])
                self.assertNotIn('anilistId', meta)
                self.assertTrue(meta['videos'])
                for video in meta['videos']:
                    self.assertTrue(video['id'] and video['title'])
                    self.assertNotIn('anilistProgress', video)
                    streams = self.get(f"{PREFIX}stream/anime/{video['id']}.json")['streams']
                    self.assertTrue(streams)
                    for stream in streams:
                        self.assertTrue(stream['name'])
                        url = urlsplit(stream['url'])
                        self.assertEqual(url.scheme, 'https')
                        self.assertTrue(url.hostname)
                        self.assertFalse(url.username or url.password or url.fragment)
                        self.assertFalse(url.hostname.endswith('.local'))
                        try:
                            address = ipaddress.ip_address(url.hostname)
                        except ValueError:
                            pass
                        else:
                            self.assertTrue(address.is_global)
                        if stream.get('downloadable'):
                            self.assertTrue(stream.get('id'))
                            self.assertTrue(url.path.lower().endswith('.mp4') or stream.get('mediaType') == 'video/mp4')

    def test_missing_units_are_404(self):
        self.get(PREFIX + 'stream/anime/unavailable.json', 404)
        self.get(PREFIX + 'meta/anime/unavailable.json', 404)
        self.get(PREFIX + 'catalog/anime/unavailable.json', 404)

    def test_all_fixture_json_is_small_and_valid(self):
        for path in (ROOT / 'anikatha').rglob('*.json'):
            with self.subTest(path=path):
                self.assertLessEqual(path.stat().st_size, LIMIT)
                json.loads(path.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
