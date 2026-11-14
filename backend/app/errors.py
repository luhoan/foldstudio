class AppError(Exception):
    """Raised anywhere in the backend; rendered as {"detail": "<code>: <message>"}."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail
