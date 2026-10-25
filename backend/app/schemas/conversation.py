from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

# Titles users type are capped here; the column itself allows 200.
TITLE_INPUT_MAX_LENGTH = 100


class ConversationCreateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=TITLE_INPUT_MAX_LENGTH)


class ConversationUpdateRequest(BaseModel):
    title: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=TITLE_INPUT_MAX_LENGTH,
        ),
    ]


class ConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str | None
    created_at: datetime
    updated_at: datetime


class MessageCreateRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    conversation_id: UUID
    role: str
    content: str
    created_at: datetime


class ChatTurnResponse(BaseModel):
    user_message: MessageResponse
    assistant_message: MessageResponse
