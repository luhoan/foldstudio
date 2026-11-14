from fastapi import Request


def get_ctx(request: Request):
    return request.app.state.ctx
