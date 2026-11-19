"""DWG conversion — ODA File Converter and CADSoftTools (cad.dll / libcad.so).

Set exactly one of USE_ODA=true or USE_CADSOFT=true in .env to choose the
active converter. If both are true, CADSoft takes priority.
"""
import os, subprocess, shutil, ctypes
from pathlib import Path
from ctypes import CDLL, c_void_p, c_char_p, c_int

HANDLE = ctypes.c_void_p

class ConverterUnavailable(ValueError): pass


# ── ODA File Converter ────────────────────────────────────────────────────────

def _oda_enabled() -> bool:
    return os.getenv('USE_ODA', 'false').strip().lower() == 'true'

def _oda_available() -> bool:
    if not _oda_enabled():
        return False
    path = os.getenv('ODA_FILE_CONVERTER', '')
    return bool(path and Path(path).is_file())

def _oda_convert(source: Path, target_dir: Path, output_type: str) -> Path:
    if not _oda_available():
        raise ConverterUnavailable(
            'ODA File Converter is not installed or USE_ODA is not set to true. '
            'DXF files can be processed now.'
        )
    target_dir.mkdir(parents=True, exist_ok=True)
    incoming = target_dir / 'oda-input'
    outgoing = target_dir / 'oda-output'
    incoming.mkdir(exist_ok=True)
    outgoing.mkdir(exist_ok=True)
    shutil.copyfile(source, incoming / source.name)
    args = [os.environ['ODA_FILE_CONVERTER'], str(incoming), str(outgoing), 'ACAD2018', output_type, '0', '1']
    if os.getenv('ODA_XVFB') == '1':
        args = ['xvfb-run', '-a', *args]
    p = subprocess.run(args, capture_output=True, text=True, timeout=120)
    matches = (list(outgoing.glob('*.' + output_type.lower())) +
               list(outgoing.glob('*.' + output_type.upper())))
    if p.returncode or not matches:
        raise ValueError('ODA conversion failed; inspect the file in a CAD application or upload an exported DXF.')
    return matches[0]


# ── CADSoftTools (cad.dll / libcad.so) ───────────────────────────────────────

_cadsoft_lib = None
_cadsoft_registered = False

def _cadsoft_enabled() -> bool:
    return os.getenv('USE_CADSOFT', 'false').strip().lower() == 'true'

def _cadsoft_load():
    global _cadsoft_lib
    if _cadsoft_lib is not None:
        return _cadsoft_lib
    if not _cadsoft_enabled():
        return None
    path = os.getenv('CADSOFT_LIB_PATH', '')
    if not path or not Path(path).is_file():
        return None
    try:
        lib = CDLL(path)
    except OSError:
        return None
    lib.CreateCAD.restype = HANDLE
    lib.CreateCAD.argtypes = [HANDLE, c_void_p]
    lib.ManagedProcessXML.restype = c_char_p
    lib.ManagedProcessXML.argtypes = [HANDLE, c_void_p]
    _cadsoft_lib = lib
    return lib

def _cadsoft_register(lib) -> None:
    global _cadsoft_registered
    if _cadsoft_registered:
        return
    user  = os.getenv('CADSOFT_LICENSE_USER', '')
    email = os.getenv('CADSOFT_LICENSE_EMAIL', '')
    key   = os.getenv('CADSOFT_LICENSE_KEY', '')
    if user and email and key:
        try:
            lib.StRgW.restype = c_int
            lib.StRgW.argtypes = [c_void_p, c_void_p, c_void_p]
            lib.StRgW(
                user.encode('utf-16')  + b'\0\0',
                email.encode('utf-16') + b'\0\0',
                key.encode('utf-16')   + b'\0\0',
            )
        except Exception:
            pass
    _cadsoft_registered = True

def _cadsoft_convert(source: Path, target_dir: Path, output_type: str) -> Path:
    lib = _cadsoft_load()
    if lib is None:
        raise ConverterUnavailable(
            'CADSoftTools library is not available or USE_CADSOFT is not set to true. '
            'Set CADSOFT_LIB_PATH and USE_CADSOFT=true in .env. DXF files can be processed now.'
        )
    _cadsoft_register(lib)
    target_dir.mkdir(parents=True, exist_ok=True)
    output_stem = str(target_dir / source.stem)
    ext = '.' + output_type.lower()
    cad = lib.CreateCAD(None, str(source).encode('utf-8'))
    if not cad:
        raise ValueError(f'CADSoft could not open {source.name}. Inspect the file in a CAD application or upload a DXF.')
    xml = (
        f'<?xml version="1.0" encoding="utf-8"?><cadsofttools version="2">'
        f'<save><ExportParams FileName="{output_stem}" Format="{ext}">'
        f'<Version>AutoCAD2004</Version></ExportParams></save>'
        f'</cadsofttools>'
    )
    lib.ManagedProcessXML(cad, xml.encode('utf-8'))
    out = target_dir / (source.stem + ext)
    if not out.exists():
        raise ValueError('CADSoft conversion produced no output. Inspect the file in a CAD application or upload an exported DXF.')
    return out


# ── Public API ────────────────────────────────────────────────────────────────

def active_engine() -> str:
    """Return the name of whichever converter will be used, for reporting."""
    if _cadsoft_enabled() and _cadsoft_load() is not None:
        return 'CADSoft'
    if _oda_available():
        return 'ODA'
    return 'None'

def available() -> bool:
    return _oda_available() or (_cadsoft_enabled() and _cadsoft_load() is not None)

def convert(source: Path, target_dir: Path, output_type: str = 'DXF') -> Path:
    # CADSoft takes priority when both flags are true
    if _cadsoft_enabled() and _cadsoft_load() is not None:
        return _cadsoft_convert(source, target_dir, output_type)
    if _oda_available():
        return _oda_convert(source, target_dir, output_type)
    raise ConverterUnavailable(
        'No DWG converter is active. Set USE_ODA=true or USE_CADSOFT=true in .env. '
        'DXF files can be processed now.'
    )
