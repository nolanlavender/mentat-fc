from fastapi import FastAPI

app = FastAPI(title="Mentat FC Model Service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
