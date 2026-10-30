import os
import unittest
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")

LEGIT_ROUTES = (
    "/",
    "/policyproof/",
    "/crossborder/",
    "/crossborder/how-it-works/",
    "/crossborder/security/",
    "/lithotraq/",
    "/tools/",
    "/creatorops/",
    "/robots.txt",
    "/sitemap.xml",
    "/llm.txt",
    "/lithotraq/llm.txt",
)

# This route is merged from another repository during deployment, so it cannot
# be checked against this repository's static files.
DEPLOY_MERGED_ROUTES = {"/tools/ai-cost-calculator/"}

NOT_FOUND_ROUTES = (
    "/nmks.php",
    "/scdm.php",
    "/files/",
    "/nonexistent-seo-check-20261029",
    "/tools/ai-cost-calculator/nope.js",
)


def route_to_file(route):
    """Return the repository file that would represent a static route."""
    route_path = urllib.parse.urlsplit(route).path
    relative = route_path.lstrip("/")
    if not relative or route_path.endswith("/"):
        relative = str(Path(relative) / "index.html")
    return REPO_ROOT / relative


def iter_site_files():
    """Walk deployable files while excluding tooling and hidden metadata."""
    for current_root, directories, filenames in os.walk(REPO_ROOT):
        directories[:] = [
            directory
            for directory in directories
            if directory not in {".claude", "tests"}
            and not directory.startswith(".")
        ]
        root_path = Path(current_root)
        for filename in filenames:
            yield root_path / filename


class DocumentFactsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.title_parts = []
        self.metas = []
        self.links = []
        self.link_elements = []
        self.script_types = []

    def handle_starttag(self, tag, attrs):
        attributes = {name.lower(): (value or "") for name, value in attrs}
        tag = tag.lower()
        if tag == "title":
            self.in_title = True
        elif tag == "meta":
            self.metas.append(attributes)
        elif tag == "a":
            self.links.append(attributes)
        elif tag == "link":
            self.link_elements.append(attributes)
        elif tag == "script":
            self.script_types.append(attributes.get("type", "").lower())

    def handle_endtag(self, tag):
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data)

    @property
    def title(self):
        return "".join(self.title_parts).strip()


class StaticRoutingTests(unittest.TestCase):
    def test_every_sitemap_location_has_a_static_file(self):
        sitemap = ET.parse(REPO_ROOT / "sitemap.xml")
        locations = sitemap.findall("{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc")
        self.assertGreater(len(locations), 0)

        for location in locations:
            with self.subTest(location=location.text):
                parsed = urllib.parse.urlsplit(location.text)
                self.assertEqual(parsed.netloc, "ncrypt.nz")
                if parsed.path in DEPLOY_MERGED_ROUTES:
                    continue
                self.assertTrue(
                    route_to_file(parsed.path).is_file(),
                    "%s does not map to an existing repository file" % location.text,
                )

    def test_legitimate_static_routes_exist(self):
        for route in LEGIT_ROUTES:
            with self.subTest(route=route):
                self.assertTrue(
                    route_to_file(route).is_file(),
                    "%s should map to %s" % (route, route_to_file(route)),
                )

    def test_custom_404_has_required_search_metadata(self):
        not_found_file = REPO_ROOT / "404.html"
        self.assertTrue(not_found_file.is_file())

        parser = DocumentFactsParser()
        parser.feed(not_found_file.read_text(encoding="utf-8"))

        robots_values = [
            meta.get("content", "").lower()
            for meta in parser.metas
            if meta.get("name", "").lower() == "robots"
        ]
        self.assertTrue(any("noindex" in value for value in robots_values))
        self.assertIn("not found", parser.title.lower())
        self.assertNotIn("application/ld+json", parser.script_types)

        for link in parser.link_elements:
            rel_tokens = link.get("rel", "").lower().split()
            self.assertNotIn("canonical", rel_tokens)

        required_links = {
            "/",
            "/policyproof/",
            "/crossborder/",
            "/lithotraq/",
            "/tools/",
            "mailto:hello@ncrypt.nz",
        }
        hrefs = {link.get("href", "") for link in parser.links}
        self.assertTrue(required_links.issubset(hrefs))
        for href in hrefs:
            self.assertTrue(
                href.startswith("/") or href.startswith("mailto:"),
                "%s is not a root-absolute or contact link" % href,
            )

    def test_custom_404_is_not_in_sitemap(self):
        sitemap_text = (REPO_ROOT / "sitemap.xml").read_text(encoding="utf-8")
        self.assertNotIn("/404.html", sitemap_text)

    def test_known_bad_routes_do_not_resolve_to_repository_files(self):
        for route in NOT_FOUND_ROUTES:
            with self.subTest(route=route):
                self.assertFalse(route_to_file(route).is_file())

        self.assertFalse((REPO_ROOT / "files").exists())
        php_files = [path for path in iter_site_files() if path.suffix.lower() == ".php"]
        self.assertEqual(php_files, [])

    def test_creatorops_remains_the_moved_page_stub(self):
        creatorops = (REPO_ROOT / "creatorops" / "index.html").read_text(encoding="utf-8")
        self.assertIn(
            '<meta http-equiv="refresh" content="0;url=https://creatorops.nz/">',
            creatorops,
        )
        self.assertIn(
            '<link rel="canonical" href="https://creatorops.nz/">',
            creatorops,
        )


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@unittest.skipUnless(BASE_URL, "BASE_URL is not set")
class LiveRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.opener = urllib.request.build_opener(NoRedirectHandler())

    def fetch(self, path):
        request = urllib.request.Request(
            BASE_URL + path,
            headers={"User-Agent": "ncrypt-routing-regression-test/1.0"},
        )
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error

        try:
            status = response.getcode()
            headers = response.headers
            body_bytes = response.read()
            charset = headers.get_content_charset() or "utf-8"
            body = body_bytes.decode(charset, errors="replace")
            return status, headers, body
        finally:
            response.close()

    def test_home_page_returns_200(self):
        status, _, _ = self.fetch("/")
        self.assertEqual(status, 200)

    def test_valid_routes_return_200(self):
        live_routes = [route for route in LEGIT_ROUTES if route not in {"/", "/creatorops/"}]
        for route in live_routes:
            with self.subTest(route=route):
                status, _, _ = self.fetch(route)
                self.assertEqual(status, 200)

    def test_creatorops_redirect_or_stub(self):
        status, headers, _ = self.fetch("/creatorops/")
        self.assertIn(status, (200, 301))
        if status == 301:
            self.assertEqual(headers.get("Location"), "https://creatorops.nz/")

    def test_unknown_routes_return_404_without_a_canonical(self):
        for route in NOT_FOUND_ROUTES:
            with self.subTest(route=route):
                status, _, body = self.fetch(route)
                self.assertEqual(status, 404)
                self.assertNotRegex(body.lower(), r"rel\s*=\s*[\"']canonical[\"']")

    def test_deploy_merged_calculator_route_returns_200(self):
        status, _, _ = self.fetch("/tools/ai-cost-calculator/")
        self.assertEqual(status, 200)

    def test_robots_is_plain_text(self):
        status, headers, _ = self.fetch("/robots.txt")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "text/plain")


if __name__ == "__main__":
    unittest.main()
