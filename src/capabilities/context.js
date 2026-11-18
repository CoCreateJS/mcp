function normalizeInstruction(object) {
    return {
        ...object,
        instructions: object.instructions ?? object.content ?? '',
        examples: object.examples ?? [],
        sources: object.sources ?? []
    };
}

function getSourcePath(source) {
    return source.pathname ?? source.path;
}

function resolveSource(source, filesByPath) {
    const requestedPath = getSourcePath(source);
    const file = filesByPath.get(requestedPath);
    if (!file) {
        return {
            ...source,
            pathname: requestedPath,
            found: false
        };
    }

    return {
        ...source,
        name: source.name ?? file.name,
        pathname: file.pathname ?? file.path ?? requestedPath,
        content: file.src ?? file.content ?? '',
        contentType: file['content-type'],
        updated: file.updated,
        found: true
    };
}

export async function loadDefaultInstructions({ crud, organization_id, logger = console }) {
    const defaultInstructions = new Map();

    const instructionsData = await crud.send({
        method: 'object.read',
        array: 'ai-instructions',
        organization_id,
        filter: { query: { enabled: true }, limit: 100 }
    });

    const objects = (instructionsData.object ?? [])
        .filter((object) => object.default && object.name)
        .map(normalizeInstruction);

    const sourcePaths = [...new Set(
        objects
            .flatMap((object) => object.sources)
            .map(getSourcePath)
            .filter(Boolean)
    )];

    let filesData = { object: [] };
    if (sourcePaths.length) {
        try {
            filesData = await crud.send({
                method: 'object.read',
                array: 'files',
                organization_id,
                filter: {
                    query: {
                        pathname: { $in: sourcePaths }
                    },
                    key: {
                        name: 1,
                        pathname: 1,
                        path: 1,
                        src: 1,
                        content: 1,
                        'content-type': 1,
                        updated: 1
                    },
                    limit: sourcePaths.length
                }
            });
        } catch (error) {
            logger.warn('[@cocreate/ai] Default instruction sources could not be loaded.', error.message);
        }
    }

    const filesByPath = new Map();
    for (const file of filesData.object ?? []) {
        const pathname = file.pathname ?? file.path;
        if (pathname) filesByPath.set(pathname, file);
    }

    for (const object of objects) {
        defaultInstructions.set(object.name, {
            ...object,
            sources: object.sources.map((source) => resolveSource(source, filesByPath))
        });
    }

    return defaultInstructions;
}
