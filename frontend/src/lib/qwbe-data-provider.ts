// The ra-core data provider over the qwbe proxy (QWB-54).
//
// The shadcn-admin-kit components talk to ra-core's DataProvider contract; the
// renderer pages live inside a scoped CoreAdminContext carrying this provider.
// Every call goes through the injected fetch -- in the app that is apiFetch,
// the same-origin proxy call that keeps the token in its httpOnly cookie, so
// no browser token ever appears here. Response and error shapes are qwbe's
// own: PageOf for lists, `{message, issues}` bodies for refusals.

import type {
  CreateParams,
  CreateResult,
  DataProvider,
  DeleteManyResult,
  DeleteResult,
  GetListParams,
  GetListResult,
  GetManyParams,
  GetManyReferenceResult,
  GetManyResult,
  GetOneParams,
  GetOneResult,
  RaRecord,
  UpdateManyResult,
  UpdateParams,
  UpdateResult,
} from "ra-core"

import {
  cubeApiPath,
  errorBody,
  errorMessage,
  listApiPath,
  type ListParams,
  type PageOf,
  type Row,
} from "./cube.ts"

// ra-core's default sort is the record id; qwbe sorts only on the fields its
// metadata marks sortable, and a request without sortBy is accepted (the same
// shape the relation typeahead sends). So an "id" sort maps to no sort at all.
function sortOf(sort: { field: string; order: string } | undefined): Partial<ListParams> {
  if (!sort?.field || sort.field === "id") return {}
  return { sortBy: sort.field, descending: sort.order === "DESC" }
}

function filtersOf(filter: Record<string, unknown>): Record<string, string> {
  const filters: Record<string, string> = {}
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (value === undefined || value === null) continue
    filters[key] = String(value)
  }
  return filters
}

// The single path a cube serves one row at. The id is a path segment, so it is
// percent-encoded (cube ids carry no slash today; the encoding is the
// boundary's job, not an assumption about the id format).
function rowApiPath(cube: string, id: RaRecord["id"]): string {
  return cubeApiPath(cube, `/${encodeURIComponent(String(id))}`)
}

async function refusal(response: Response): Promise<Error> {
  // qwbe's own message wins; a non-JSON body must not lose the text.
  return new Error(errorMessage(await errorBody(response)))
}

// The factory takes the fetch so the tests can stub qwbe at the HTTP boundary;
// the app passes apiFetch. Rows keep qwbe's own shape (Record<string, unknown>
// with a string id); the generic RecordType assertions are the contract seam.
export function qwbeDataProvider(doFetch: typeof fetch): DataProvider {
  const readJson = async (url: string): Promise<unknown> => {
    const response = await doFetch(url)
    if (!response.ok) throw await refusal(response)
    return (await response.json()) as unknown
  }

  return {
    getList: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
      { pagination, sort, filter }: GetListParams,
    ): Promise<GetListResult<RecordType>> => {
      const page = pagination?.page ?? 1
      const perPage = pagination?.perPage ?? 25
      const response = (await readJson(
        listApiPath(cube, {
          offset: (page - 1) * perPage,
          limit: perPage,
          ...sortOf(sort),
          filters: filtersOf(filter),
        }),
      )) as PageOf<Row>
      return { data: response.rows as RecordType[], total: response.total }
    },

    getOne: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
      { id }: GetOneParams<RecordType>,
    ): Promise<GetOneResult<RecordType>> => ({
      data: (await readJson(rowApiPath(cube, id))) as RecordType,
    }),

    // The batch read the kit's reference fields resolve titles with: qwbe's
    // `ids=` is a batch, not a page -- no limit is sent, qwbe sizes it.
    getMany: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
      { ids }: GetManyParams<RecordType>,
    ): Promise<GetManyResult<RecordType>> => {
      const unique = [...new Set(ids.map(String))]
      if (unique.length === 0) return { data: [] as RecordType[] }
      const query = new URLSearchParams()
      query.set("ids", unique.join(","))
      const response = (await readJson(`${cubeApiPath(cube)}?${query.toString()}`)) as PageOf<Row>
      return { data: response.rows as RecordType[] }
    },

    // The unsupported stubs drop the params parameter entirely: a function
    // with fewer parameters is assignable to the DataProvider contract, and
    // no unused-variable lint suppression is needed.
    getManyReference: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
    ): Promise<GetManyReferenceResult<RecordType>> => {
      throw new Error(
        `getManyReference is not supported by the qwbe data provider (${String(cube)})`,
      )
    },

    update: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
      { id, data }: UpdateParams<RecordType>,
    ): Promise<UpdateResult<RecordType>> => {
      const response = await doFetch(rowApiPath(cube, id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      })
      if (!response.ok) throw await refusal(response)
      return { data: (await response.json()) as RecordType }
    },

    updateMany: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
    ): Promise<UpdateManyResult<RecordType>> => {
      throw new Error(`updateMany is not supported by the qwbe data provider (${String(cube)})`)
    },

    create: async <
      RecordType extends Omit<RaRecord, "id">,
      ResultRecordType extends RaRecord = RecordType & { id: RaRecord["id"] },
    >(
      cube: string,
      { data }: CreateParams<RecordType>,
    ): Promise<CreateResult<ResultRecordType>> => {
      const response = await doFetch(cubeApiPath(cube), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      })
      if (!response.ok) throw await refusal(response)
      return { data: (await response.json()) as ResultRecordType }
    },

    // qwbe has no DELETE endpoints; the provider refuses rather than faking.
    delete: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
    ): Promise<DeleteResult<RecordType>> => {
      throw new Error(`delete is not supported by the qwbe data provider (${String(cube)})`)
    },

    deleteMany: async <RecordType extends RaRecord = RaRecord>(
      cube: string,
    ): Promise<DeleteManyResult<RecordType>> => {
      throw new Error(`deleteMany is not supported by the qwbe data provider (${String(cube)})`)
    },
  }
}
