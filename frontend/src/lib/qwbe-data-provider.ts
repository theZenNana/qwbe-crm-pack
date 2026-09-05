// The ra-core data provider of the admin-kit pilot (QWB-53): one cube, two
// verbs. getOne reads the row and update PATCHes exactly the edited keys, both
// through the same server-side proxy every other call uses, so the qwbe token
// stays in the httpOnly cookie and apiFetch's 401 reaction is unchanged.
//
// A refused PATCH becomes ra-core's HttpError whose body.errors maps each
// qwbe issue to the field it names -- that is the contract useEditController
// reads in pessimistic mode to put the message under the input -- and whose
// message is qwbe's own text for everything else.
//
// ponytail: getOne and update only. The list, create and delete surfaces keep
// their existing components; add a verb here the day a kit component needs it.

import { HttpError, type DataProvider } from "ra-core"

import {
  apiFetch,
  cubeApiPath,
  errorBody,
  errorMessage,
  patchBodyOf,
  type FieldMetadata,
  type Row,
} from "./cube.ts"

// body.errors as ra-core expects it: field name -> message, from qwbe's
// per-field issues. An issue without a string path is not a field error.
export function fieldErrorsOf(body: unknown): Record<string, string> {
  const errors: Record<string, string> = {}
  const issues = (body as { issues?: unknown } | null)?.issues
  if (!Array.isArray(issues)) return errors
  for (const issue of issues) {
    const path = (issue as { path?: unknown[] })?.path
    const message = (issue as { message?: unknown })?.message
    if (Array.isArray(path) && typeof path[0] === "string" && typeof message === "string") {
      errors[path[0]] ??= message
    }
  }
  return errors
}

async function refused(response: Response): Promise<HttpError> {
  const body = await errorBody(response)
  return new HttpError(errorMessage(body), response.status, {
    errors: fieldErrorsOf(body),
  })
}

const unsupported = (verb: string) => async (): Promise<never> => {
  throw new Error(`${verb} is not supported by the qwbe pilot data provider`)
}

export function qwbeDataProvider(
  cube: string,
  fields: FieldMetadata[],
  doFetch: typeof fetch = apiFetch,
): DataProvider {
  return {
    getOne: async (_resource, { id }) => {
      const response = await doFetch(cubeApiPath(cube, `/${id}`))
      if (!response.ok) throw await refused(response)
      return { data: (await response.json()) as never }
    },
    update: async (_resource, { id, data, previousData }) => {
      const body = patchBodyOf(fields, (previousData ?? {}) as Row, data as Row)
      // Nothing changed after coercion: no request, the row stays as it is
      // (the same no-op the inline editor's saveCell reports as "unchanged").
      if (Object.keys(body).length === 0) return { data: previousData as never }
      const response = await doFetch(cubeApiPath(cube, `/${id}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw await refused(response)
      return { data: (await response.json()) as never }
    },
    getList: unsupported("getList"),
    getMany: unsupported("getMany"),
    getManyReference: unsupported("getManyReference"),
    create: unsupported("create"),
    updateMany: unsupported("updateMany"),
    delete: unsupported("delete"),
    deleteMany: unsupported("deleteMany"),
  }
}
