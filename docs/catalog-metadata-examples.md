# Catalog metadata examples

These two entries are an excerpt of `GET /anikatha/catalog/manga/top-rated.json` from the local Worker. The Worker replay used the public MangaDex catalog and statistics captured on 26 November 2026. The examples show observed values for **One Piece** and **The Greatest Estate Developer**. Their scores, ranks, statuses, and covers can change upstream.

The MangaDex record for One Piece does not expose a supported format tag, so the Worker omits `format`. The Greatest Estate Developer has an explicit Web Comic format tag. Both records keep the broad HTTP media type `manga`. The generic catalog and title detail responses omit `rank` because those responses do not represent this ranked snapshot.

```json
{
  "metas": [
    {
      "id": "md:a1c7c817-4e59-43b7-9365-09675a149a6f",
      "type": "manga",
      "name": "One Piece",
      "genres": [
        "Sci-Fi",
        "Action",
        "Comedy",
        "Adventure",
        "Drama",
        "Fantasy"
      ],
      "tags": [
        "Award Winning",
        "Monsters",
        "Animals",
        "Gore"
      ],
      "tagIds": [
        "0a39b5a1-b235-4886-a747-1d05d216532d",
        "36fd93ea-e8b8-445e-b836-358f02b3d33d",
        "3de8c75d-8ee3-48ff-98ee-e20a65c86451",
        "b29d6a3d-1569-4e7a-8caf-7557bc92cd5d"
      ],
      "year": 1997,
      "status": "Publishing",
      "poster": "https://uploads.mangadex.org/covers/a1c7c817-4e59-43b7-9365-09675a149a6f/2f4aca53-64c7-46ac-ae85-3bc9b3169890.png.512.jpg",
      "communityScore": 96,
      "rank": 19
    },
    {
      "id": "md:d7f56ace-cd30-48b9-8b64-afeca0077fca",
      "type": "manga",
      "name": "Yeokdaegeum Yeongji Seolgyesa",
      "genres": [
        "Action",
        "Comedy",
        "Adventure",
        "Isekai",
        "Fantasy"
      ],
      "tags": [
        "Reincarnation",
        "Monsters",
        "Long Strip",
        "Magic",
        "Web Comic",
        "Adaptation",
        "Full Color"
      ],
      "tagIds": [
        "0bc90acb-ccc1-44ca-a34a-b9f3a73259d0",
        "36fd93ea-e8b8-445e-b836-358f02b3d33d",
        "3e2b8dae-350e-4ab8-a8ce-016e844b9f0d",
        "a1f53773-c69a-4ce5-8cab-fffcd90b1565",
        "e197df38-d0e7-43b5-9b09-2842d0c326dd",
        "f4122d1c-3b44-44d0-9936-ff7502c39ad3",
        "f5ba408b-0e7a-484d-8d49-4e9125ac96de"
      ],
      "format": "Web Comic",
      "year": 2021,
      "status": "Completed",
      "poster": "https://uploads.mangadex.org/covers/d7f56ace-cd30-48b9-8b64-afeca0077fca/c2613a1e-426f-4ee3-a6f7-caf003324dc7.jpg.512.jpg",
      "communityScore": 96,
      "rank": 6
    }
  ]
}
```
