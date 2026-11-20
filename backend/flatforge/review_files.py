"""Read measured review data without inferring identity from filenames."""
import json

MAX_REVIEW_BYTES = 1024 * 1024


def select_review(raw: bytes, source_sha256: str) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Review JSON contains duplicate keys.')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('Review JSON must contain finite numbers.')

    if len(raw) > MAX_REVIEW_BYTES:
        raise ValueError('Review file exceeds 1 MB.')
    try:
        document = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique_object,
                              parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError('Upload a valid UTF-8 review JSON file.') from exc
    panels = document.get('panels') if isinstance(document, dict) else None
    if not isinstance(panels, dict) or not panels:
        raise ValueError('Review JSON needs a nonempty panels object.')
    matches = [entry for entry in panels.values() if isinstance(entry, dict)
               and entry.get('source_sha256') == source_sha256]
    if len(matches) != 1:
        raise ValueError('Review file must contain exactly one entry matching this exact source drawing. '
                         'Renaming is allowed; changed drawings and different DWG conversions need new review data.')
    entry = matches[0]
    if not isinstance(entry.get('settings'), dict) or not isinstance(entry.get('overrides'), dict):
        raise ValueError('The matching entry needs settings and overrides objects.')
    return entry
