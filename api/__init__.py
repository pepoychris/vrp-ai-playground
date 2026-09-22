"""Backend workspace package.

The importable application lives in ``api.app``. Keeping ``api`` as a package lets
the repository-root test suite import the app the same way the container does
(``app.main`` inside the image, ``api.app.main`` from the repository root).
"""
