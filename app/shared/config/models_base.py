from pydantic import BaseModel, ConfigDict


class BaseConfigModel(BaseModel):
    """Base class for all generated config models.

    ``extra='ignore'`` ensures forward-compatibility in distributed systems:
    a newer ConfigService can emit keys that an older consumer safely ignores.
    """

    model_config = ConfigDict(extra="ignore")
