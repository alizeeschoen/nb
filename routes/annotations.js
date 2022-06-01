const express = require('express');
const User = require('../models').User;
const Class = require('../models').Class;
const Annotation = require('../models').Annotation;
const Followers = require('../models').Followers;
const Thread = require('../models').Thread;
const Source = require('../models').Source;
const Location = require('../models').Location;
const HtmlLocation = require('../models').HtmlLocation;
const AnnotationMedia = require('../models').AnnotationMedia
const Tag = require('../models').Tag;
const router = express.Router();
const { Op } = require("sequelize");
const utils = require('../models/utils')(require('../models'));
let socketapi = require("../socketapi")
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const upload = multer({ dest: 'public/media/' });

/**
* Get my classes for a given source
* @name GET/api/annotations/myClasses
*/
router.get('/myClasses', async (req, res) => {
    const allSourcesByFilepath = await Source.findAll({ where: { filepath: req.query.url } })
    const user = await User.findByPk(req.user.id)
    const sections = await user.getMemberSections({ raw: true })
    const myClassesAsStudent = await Promise.all(sections.map((section) => Class.findByPk(section.class_id)))
    const myClassesIDsAsStudent = myClassesAsStudent.map(classObj => classObj["id"])
    const uniqueMyClassesAsStudent = myClassesAsStudent.filter((value, index) => {
        return myClassesIDsAsStudent.indexOf(value["id"]) === index
    });
    const myClassesAsInstructor = await user.getInstructorClasses()
    const myClasses = [...uniqueMyClassesAsStudent, ...myClassesAsInstructor]
    const myClassesBySource = myClasses.filter(myClass => allSourcesByFilepath.find(source => source.class_id == myClass.id))
    res.status(200).send(myClassesBySource)
});

router.get('/myCurrentSection', (req, res) => {
    User.findByPk(req.user.id).then((user) => {
        user.getMemberSections({ raw: true }).then((sections) => {
            for (const section of sections) {
                if (section.class_id === req.query.class && !section.is_global) {
                    res.status(200).send(section.id)
                    return;
                }
            }
            res.status(200).send("")
        })
    })

})

/**
* Get all users for a given source
* @name GET/api/annotations/allUsers
*/
router.get('/allUsers', (req, res) => {
    Source.findOne({
        where: { [Op.and]: [{ filepath: req.query.url }, { class_id: req.query.class }] }, include: [{
            association: 'Class',
            include: [
                { association: 'GlobalSection', include: [{ association: 'MemberStudents', attributes: ['id', 'username', 'first_name', 'last_name'] }] },
                { association: 'Instructors', attributes: ['id', 'username', 'first_name', 'last_name'] }]
        }]
    })
        .then((source) => {
            const students = source.Class.GlobalSection.MemberStudents
                .map((user) => simplifyUser(user, 'student'))
                .reduce((obj, user) => { obj[user.id] = user; return obj; }, {});
            const instructors = source.Class.Instructors
                .map((user) => simplifyUser(user, 'instructor'))
                .reduce((obj, user) => { obj[user.id] = user; return obj; }, {});
            res.status(200).json(Object.assign(students, instructors));
        }
        );
});

/**
* Get all users for a given source
* @name GET/api/annotations/allTagTypes
*/
router.get('/allTagTypes', (req, res) => {
    Source.findOne({
        where: { [Op.and]: [{ filepath: req.query.url }, { class_id: req.query.class }] }, include: [{
            association: 'Class',
            include: [{ association: 'TagTypes' }]
        }]
    })
        .then((source) => {
            const hashtags = source.Class.TagTypes
                .map((tag_type) => tag_type.get({ plain: true }))
                .reduce((obj, tag) => { obj[tag.id] = tag; return obj; }, {});
            res.status(200).json(hashtags);
        }
        );
});

/**
 * Get the stats for thetop-level annotation for a given source
 * The stats are: my annotations, reply requests, unread, and total 
 * @name GET/api/annotations/stats
 * @param url: source url
 * @param class: source class id
 * @return [{
 * me: number of annotations written by user
 * unread: number of unread annotations,
 * replyRequests: number of replyRequests annotation,
 * total: total number of annotations
 * }] 
 */
router.get('/stats', (req, res) => {
    Source.findOne({
        where: { [Op.and]: [{ filepath: req.query.url }, { class_id: req.query.class }] }
    }).then(source => {
        source.getLocations({
            include:
                [
                    { association: 'HtmlLocation' },
                    {
                        association: 'Thread',
                        required: true,
                        include: [
                            {
                                association: 'HeadAnnotation', attributes: ['id'],
                                include: [
                                    { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                ]
                            },
                            {
                                association: 'AllAnnotations', separate: true, attributes: ['id'],
                                include: [
                                    { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                ]
                            },
                            { association: 'SeenUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        ]
                    }
                ]
        }).then(locations => {
            let me = 0
            let unread = 0
            let replyRequests = 0
            let total = 0
            let thread = 0
            // TODO: is this the correct way to filter replies?
            locations.forEach((location) => {
                
                location.Thread.AllAnnotations.forEach((annot) => {
                    if (annot.Author.id === req.user.id ){
                        me += 1
                    }

                    replyRequests += annot.ReplyRequesters.length
                    total += 1
                })
                if (!(location.Thread.SeenUsers
                    .reduce((bool, user) => bool || user.id == req.user.id, false))){
                    unread += location.Thread.AllAnnotations.length
                }
                thread += 1

            });
            res.status(200).json({ 'me': me, 'unread': unread, 'replyRequests': replyRequests, 'thread': thread, 'total': total });
        })
    });
});

/**
* Get all top-level annotation (+ replies) for a given source
* @name GET/api/annotations/annotation
* @param url: source url
* @param class: source class id
* @return [{
* id: id of annotation
* content: text content of annotation,
* range: json for location range,
* author: id of author,
* tags: list of ids of tag types,
* userTags: list of ids of users tagged,
* visibility: string enum,
* anonymity: string enum,
* replyRequest: boolean,
* star: boolean
* }]
*/
router.get('/annotation', (req, res) => {
    Followers.findAll({ where: { user_id: req.user.id}}).then((follows) => {
    Source.findOne({
        where: { [Op.and]: [{ filepath: req.query.url }, { class_id: req.query.class }] },
        include: [{
            association: 'Class',
            include: [
                { association: 'Instructors', attributes: ['id'] },
                {
                    association: 'GlobalSection', include: [{
                        association: 'MemberStudents', attributes: ['id']
                    }]
                },
                {
                    association: 'Sections', separate: true, include: [{ // with the hasMany Sections association, add a "separate: true" to make this join happen separately so that there are no duplicate joins
                        association: 'MemberStudents', attributes: ['id']
                    }]
                }
            ]
        }]
    }).then(source => {
        let instructors = new Set(source.Class.Instructors.map(user => user.id)) // convert to set so faster to check if a user is in this set
        let globalSectionStudents = new Set(source.Class.GlobalSection.MemberStudents.map(user => user.id)) // convert to set so faster to check if a user is in this set
        let isUserInstructor = instructors.has(req.user.id);
        let isUserStudent = globalSectionStudents.has(req.user.id);

        if (!isUserInstructor && !isUserStudent) {
            res.status(200).json([]);
            return;
        }

        let usersICanSee = new Set([]) // convert to set so faster to check if a user is in this set
        let isSingleSectionClass = source.Class.Sections.length === 1

        for (const section of source.Class.Sections) {
            let memberIds = section.MemberStudents.map(user => user.id)
            if ((isUserInstructor && section.is_global) || (isSingleSectionClass)) {
                usersICanSee = new Set(memberIds)
                break;
            } else {
                if (memberIds.indexOf(req.user.id) >= 0 && !section.is_global) {
                    usersICanSee = new Set(memberIds)
                    break
                }
            }
        }
        source.getLocations({
            include:
                [
                    { association: 'HtmlLocation' },
                    {
                        association: 'Thread',
                        required: true,
                        include: [
                            {
                                association: 'HeadAnnotation', attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                                include: [
                                    { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'TaggedUsers', attributes: ['id'] },
                                    { association: 'Tags', attributes: ['tag_type_id'] },
                                    { association: 'Bookmarkers', attributes: ['id'] },
                                    { association: 'Spotlight', attributes: ['id', 'type'] },
                                    { association: 'Media', attributes: ['filepath', 'type'] },
                                ]
                            },
                            {
                                association: 'AllAnnotations', separate: true, attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                                include: [
                                    { association: 'Parent', attributes: ['id'] },
                                    { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                    { association: 'TaggedUsers', attributes: ['id'] },
                                    { association: 'Tags', attributes: ['tag_type_id'] },
                                    { association: 'Bookmarkers', attributes: ['id'] },
                                    { association: 'Media', attributes: ['filepath', 'type'] },
                                ]
                            },
                            { association: 'SeenUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            { association: 'RepliedUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        ]
                    }
                ]
        }).then(locations => {
            let annotations = {}
            let headAnnotations = []

            // TODO: is this the correct way to filter replies?
            let goodLocations = locations.filter((location) => {
                try {
                    let head = location.Thread.HeadAnnotation;

                    if (head.visibility === 'MYSELF' && head.Author.id !== req.user.id) {
                        return false;
                    }
                    if (head.visibility === 'INSTRUCTORS' && !isUserInstructor && head.Author.id !== req.user.id) {
                        return false;
                    } if (req.query.sectioned === 'true' && isUserStudent && head.Author.id !== req.user.id && !usersICanSee.has(head.Author.id) && !instructors.has(head.Author.id)) {
                        return false;
                    }
                    return true;
                } catch (e) {
                    // console.log(location);
                    console.log('\n\n\nGET/api/annotations/annotation')
                    console.log(e)
                    console.log(location);
                    console.log(location.Thread);
                    console.log(location.Thread.HeadAnnotation);
                    return false;
                }
            })

            goodLocations.forEach((location) => {
                // store all head annotaitons
                headAnnotations.push(utils.createAnnotation(location, location.Thread.HeadAnnotation, instructors, req.user.id, follows))

                // store all associated annotations in {parent_id : annotation} annotations object
                location.Thread.AllAnnotations.forEach((annotation) => {
                    if (annotation.Parent) {
                        if (!(annotation.Parent.id in annotations)) {
                            annotations[annotation.Parent.id] = []
                        }
                        annotations[annotation.Parent.id].push(utils.createAnnotation(location, annotation, instructors, req.user.id, follows))
                    }
                })
            });

            res.status(200).json({ 'headAnnotations': headAnnotations, 'annotationsData': annotations });

        })
    })
})
});

/**
* Make new thread for a given annotation (and tell users with visbility permissions to query for this specific thread w/ socketio)
* @name POST/api/annotations/annotation
* @param url: source url
* @param class: source class id
* @param content: text content of annotation
* @param range: json for location range
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
* @param bookmark: boolean
*/
router.post('/annotation', async (req, res) => {
    const range = req.body.range

    const source = await Source.findOne({
        where: { [Op.and]: [{ filepath: req.body.url }, { class_id: req.body.class }] },
        include: [{
            association: 'Class',
            include: [{ association: 'Instructors', attributes: ['id'] },
            { association: 'GlobalSection', include: [{ association: 'MemberStudents', attributes: ['id'] }] },
            // with the hasMany Sections association, add a "separate: true" to make this join happen separately so that there are no duplicate joins
            { association: 'Sections', separate: true, include: [{ association: 'MemberStudents', attributes: ['id'] }] }
            ]
        }]
    })

    let instructors = new Set(source.Class.Instructors.map(user => user.id))
    let globalSectionStudents = new Set(source.Class.GlobalSection.MemberStudents.map(user => user.id))
    let isUserInstructor = instructors.has(req.user.id);
    let isUserStudent = globalSectionStudents.has(req.user.id);

    if (!isUserInstructor && !isUserStudent) {
        res.status(200).json([]);
        return;
    }

    let usersICanSee = []
    let isSingleSectionClass = source.Class.Sections.length === 1

    for (const section of source.Class.Sections) {
        let memberIds = section.MemberStudents.map(user => user.id)

        if ((isUserInstructor && section.is_global) || (isSingleSectionClass)) {
            usersICanSee = memberIds
            break;
        } else {
            if (memberIds.indexOf(req.user.id) >= 0 && !section.is_global) {
                usersICanSee = memberIds
                break
            }
        }
    }

    const location = await Location.create({ source_id: source.id })
    await Promise.all([
        HtmlLocation.create({ start_node: range.start, end_node: range.end, start_offset: range.startOffset, end_offset: range.endOffset, location_id: location.id }),
        Thread.create({ location_id: location.id, HeadAnnotation: { content: req.body.content, visibility: req.body.visibility, anonymity: req.body.anonymity, endorsed: req.body.endorsed, author_id: req.user.id } },
            { include: [{ association: 'HeadAnnotation' }] })
            .then(thread => {
                let annotation = thread.HeadAnnotation;
                req.body.tags.forEach((tag) => Tag.create({ annotation_id: annotation.id, tag_type_id: tag }));
                req.body.userTags.forEach((user_id) => User.findByPk(user_id).then(user => annotation.addTaggedUser(user)));

                User.findByPk(req.user.id).then(user => {
                    if (req.body.replyRequest) annotation.addReplyRequester(user);
                    if (req.body.star) annotation.addStarrer(user);
                    if (req.body.bookmark) annotation.addBookmarker(user);
                    thread.setSeenUsers([user]);
                    thread.setRepliedUsers([user]);
                });

                annotation.setThread(thread).then(() => {
                    res.status(200).json(annotation)
                    const io = socketapi.io

                    const urlHash = crypto.createHash('md5').update(req.body.url).digest('hex');
                    const globalRoomId = `${urlHash}:${req.body.class}`
                    const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))

                    // TODO: check the sync here
                    if (annotation.visibility === 'INSTRUCTORS') {
                        // Since instructors are only part of the global section, only emit to the global room
                        io.to(globalRoomId).emit('new_thread', { sourceUrl: req.body.url, authorId: req.user.id, userIds: [...instructors], threadId: thread.id, classId: req.body.class, taggedUsers: [...req.body.userTags] })
                        io.emit('new_thread', { sourceUrl: req.body.url, authorId: req.user.id, userIds: [...instructors], threadId: thread.id, classId: req.body.class, taggedUsers: [...req.body.userTags], replyRequest: req.body.replyRequest })
                    } else if (annotation.visibility === 'EVERYONE') {
                        io.to(globalRoomId).emit('new_thread', { sourceUrl: req.body.url, authorId: req.user.id, userIds: [...instructors, ...usersICanSee], threadId: thread.id, classId: req.body.class, taggedUsers: [...req.body.userTags] })
                        classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_thread', { sourceUrl: req.body.url, authorId: req.user.id, userIds: [...instructors, ...usersICanSee], threadId: thread.id, classId: req.body.class, taggedUsers: [...req.body.userTags] }))
                        io.emit('new_thread', { sourceUrl: req.body.url, authorId: req.user.id, userIds: [...instructors, ...usersICanSee], threadId: thread.id, classId: req.body.class, taggedUsers: [...req.body.userTags],replyRequest: req.body.replyRequest  })

                    }
                   io.emit('create_new_thread', {filepath: req.body.url, class_id: req.body.class, user_id: req.user.id, seen_user: thread.SeenUsers, parent: thread.id, reply_requests: req.body.replyRequest})


                });
            })
    ])
});

/**
* Make new media thread for a given annotation (and tell users with visbility permissions to query for this specific thread w/ socketio)
* @name POST/api/annotations/media/annotation
* @param url: source url
* @param class: source class id
* @param content: text content of annotation
* @param range: json for location range
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
* @param bookmark: boolean
*/
router.post('/media/annotation', upload.single("file"), async (req, res) => {
    try {
        const filepath = `/media/${req.file.filename}`
        const body = JSON.parse(req.body.annotation)
        const range = body.range

        const source = await Source.findOne({
            where: { [Op.and]: [{ filepath: body.url }, { class_id: body.class }] },
            include: [{
                association: 'Class',
                include: [{ association: 'Instructors', attributes: ['id'] },
                { association: 'GlobalSection', include: [{ association: 'MemberStudents', attributes: ['id'] }] },
                // with the hasMany Sections association, add a "separate: true" to make this join happen separately so that there are no duplicate joins
                { association: 'Sections', separate: true, include: [{ association: 'MemberStudents', attributes: ['id'] }] }
                ]
            }]
        })

        let instructors = new Set(source.Class.Instructors.map(user => user.id))
        let globalSectionStudents = new Set(source.Class.GlobalSection.MemberStudents.map(user => user.id))
        let isUserInstructor = instructors.has(req.user.id);
        let isUserStudent = globalSectionStudents.has(req.user.id);

        if (!isUserInstructor && !isUserStudent) {
            res.status(200).json([]);
            return;
        }

        let usersICanSee = []
        let isSingleSectionClass = source.Class.Sections.length === 1

        for (const section of source.Class.Sections) {
            let memberIds = section.MemberStudents.map(user => user.id)

            if ((isUserInstructor && section.is_global) || (isSingleSectionClass)) {
                usersICanSee = memberIds
                break;
            } else {
                if (memberIds.indexOf(req.user.id) >= 0 && !section.is_global) {
                    usersICanSee = memberIds
                    break
                }
            }
        }

        const location = await Location.create({ source_id: source.id })

        const [htmlLocation, thread] = await Promise.all([
            HtmlLocation.create({ start_node: range.start, end_node: range.end, start_offset: range.startOffset, end_offset: range.endOffset, location_id: location.id }),
            Thread.create({ location_id: location.id, HeadAnnotation: { content: body.content, visibility: body.visibility, anonymity: body.anonymity, author_id: req.user.id } }, { include: [{ association: 'HeadAnnotation' }] })
        ])

        const annotation = thread.HeadAnnotation;
        body.tags.forEach((tag) => Tag.create({ annotation_id: annotation.id, tag_type_id: tag }));
        body.userTags.forEach((user_id) => User.findByPk(user_id).then(user => annotation.addTaggedUser(user)));

        const user = await User.findByPk(req.user.id)
        if (body.replyRequest) annotation.addReplyRequester(user);
        if (body.star) annotation.addStarrer(user);
        if (body.bookmark) annotation.addBookmarker(user);
        thread.setSeenUsers([user]);
        thread.setRepliedUsers([user]);

        const annotationMedia = await AnnotationMedia.create({ type: body.type, filepath: filepath })
        await annotation.setThread(thread)
        await annotation.setMedia(annotationMedia)

        const annotationWithMedia = await Annotation.findByPk(annotation.id, { include: [{ association: 'Thread' }, { association: 'Media' }] })
        res.status(200).json(annotationWithMedia)

        const io = socketapi.io
        const urlHash = crypto.createHash('md5').update(body.url).digest('hex');
        const globalRoomId = `${urlHash}:${body.class}`
        const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))

        // TODO: check the sync here
        if (annotation.visibility === 'INSTRUCTORS') {
            // Since instructors are only part of the global section, only emit to the global room
            io.to(globalRoomId).emit('new_thread', { sourceUrl: body.url, authorId: req.user.id, userIds: [...instructors], threadId: thread.id, classId: body.class, taggedUsers: [...body.userTags] })
        } else if (annotation.visibility === 'EVERYONE') {
            io.to(globalRoomId).emit('new_thread', { sourceUrl: body.url, authorId: req.user.id, userIds: [...instructors, ...usersICanSee], threadId: thread.id, classId: body.class, taggedUsers: [...body.userTags] })
            classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_thread', { sourceUrl: body.url, authorId: req.user.id, userIds: [...instructors, ...usersICanSee], threadId: thread.id, classId: body.class, taggedUsers: [...body.userTags] }))
        }
    } catch (error) {
        console.error('\n\nannotations/media/annotation');
        console.error(error);
        res.status(500).json(error)
    }

});

/**
* Get a specific thread (+ respective reply annotations) for a given source
* Assume that the user requesting is authorized to view the thread (part of the section, and nt only visible to instructors/myself)
* @name GET/api/annotations/specific_thread
* @param source_url: source url
* @param class_id: source class id
* @param id: id of thread
*/
router.get('/specific_thread', (req, res) => {
    let classInstructors = new Set([])
    Followers.findAll({ where: { user_id: req.user.id}}).then((follows) => {
  
    Source.findOne({
        where: { [Op.and]: [{ filepath: req.query.source_url }, { class_id: req.query.class_id }] },
        include: [{
            association: 'Class',
            include: [
                { association: 'Instructors', attributes: ['id'] },
            ]
        }]
    })
        .then(source => {
            classInstructors = new Set(source.Class.Instructors.map(user => user.id)) // convert to set so faster to check if a user is in this set
            Thread.findOne({
                where: { id: req.query.thread_id },
                include: [
                    {
                        association: 'Location', include: [{ association: 'HtmlLocation' }],
                    },
                    {
                        association: 'HeadAnnotation', attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                        include: [
                            { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            { association: 'TaggedUsers', attributes: ['id'] },
                            { association: 'Tags', attributes: ['tag_type_id'] },
                            { association: 'Bookmarkers', attributes: ['id'] },
                            { association: 'Media', attributes: ['filepath', 'type'] },
                        ]
                    },
                    {
                        association: 'AllAnnotations', separate: true, attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                        include: [
                            { association: 'Parent', attributes: ['id'] },
                            { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            { association: 'TaggedUsers', attributes: ['id'] },
                            { association: 'Tags', attributes: ['tag_type_id'] },
                            { association: 'Bookmarkers', attributes: ['id'] },
                            { association: 'Media', attributes: ['filepath', 'type'] },
                        ]
                    },
                    { association: 'SeenUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                    { association: 'RepliedUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                ]
            })
                .then(thread => {
                    let annotations = {}
                    let headAnnotation = utils.createAnnotationFromThread(thread.Location.HtmlLocation, thread.HeadAnnotation, thread.SeenUsers, classInstructors, req.user.id, follows)

                    thread.AllAnnotations.forEach((annotation) => {
                        if (annotation.Parent) {
                            if (!(annotation.Parent.id in annotations)) {
                                annotations[annotation.Parent.id] = []
                            }
                            annotations[annotation.Parent.id].push(utils.createAnnotationFromThread(thread.Location.HtmlLocation, annotation, thread.SeenUsers, classInstructors, req.user.id, follows))
                        }
                    })
                    res.status(200).json({ 'headAnnotation': headAnnotation, 'annotationsData': annotations });
                })
                .catch(function (err) {
                    console.log(err)
                    res.status(res.status(400).json({ msg: "Error fetching specific thread" }))
                })
        })
        .catch(function (err) {
            console.log(err)
            res.status(res.status(400).json({ msg: "Error fetching specific thread" }))
        })
    })
    .catch(function (err) {
        console.log(err)
        res.status(res.status(400).json({ msg: "Error fetching specific user" }))
    })
})



/**
* Get all reply annotation for a given parent
* @name GET/api/annotations/reply/:id
* @param id: parent id
* @return [{
* id: id of annotation
* content: text content of annotation,
* range: json for location range,
* author: id of author,
* tags: list of ids of tag types,
* userTags: list of ids of users tagged,
* visibility: string enum,
* anonymity: string enum,
* replyRequest: boolean,
* star: boolean
* }]
*/
router.get('/reply/:id', (req, res) => {
    Annotation.findByPk(req.params.id, {
        include: [{
            association: 'Thread', attributes: ['id'],
            include: [{
                association: 'Location', attributes: ['id'],
                include: [{
                    association: 'Source', attributes: ['id'],
                    include: [{
                        association: 'Class', attributes: ['id'],
                        include: [{ association: 'Instructors', attributes: ['id'] }]
                    }]
                }]
            }]
        }]
    })
        .then(parent => parent.Thread.Location.Source.Class.Instructors.map(user => user.id))
        .then(instructors => {
            Annotation.findAll({
                where: { parent_id: req.params.id },
                attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                include: [
                    { association: 'Thread', include: [{ association: 'SeenUsers' }] },
                    { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                    { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                    { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                    { association: 'TaggedUsers', attributes: ['id'] },
                    { association: 'Tags', attributes: ['tag_type_id'] },
                    { association: 'Bookmarkers', attributes: ['id'] }
                ]
            })
                .then(annotations => {
                    let isUserInstructor = instructors.indexOf(req.user.id) >= 0;
                    return annotations
                        .filter(annotation => {
                            if (annotation.visibility === 'MYSELF'
                                && annotation.Author.id !== req.user.id) {
                                return false;
                            }
                            if (annotation.visibility === 'INSTRUCTORS' && !isUserInstructor) {
                                return false;
                            }
                            return true;
                        })
                        .map(annotation => {
                            let reply = {};
                            reply.id = annotation.id;
                            reply.range = null;
                            reply.parent = req.params.id;
                            reply.timestamp = annotation.dataValues.created_at;
                            reply.author = annotation.Author.id;
                            reply.authorName = annotation.Author.first_name + " " + annotation.Author.last_name;
                            reply.instructor = instructors.indexOf(annotation.Author.id) >= 0;
                            reply.html = annotation.content;
                            reply.hashtags = annotation.Tags.map(tag => tag.tag_type_id);
                            reply.people = annotation.TaggedUsers.map(userTag => userTag.id);
                            reply.visibility = annotation.visibility;
                            reply.endorsed = annotation.endorsed;
                            reply.anonymity = annotation.anonymity;
                            reply.replyRequestedByMe = annotation.ReplyRequesters
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            reply.replyRequestCount = annotation.ReplyRequesters.length;
                            reply.starredByMe = annotation.Starrers
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            reply.starCount = annotation.Starrers.length;
                            reply.seenByMe = annotation.Thread.SeenUsers
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            reply.bookmarked = annotation.Bookmarkers
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            return reply;
                        });
                })
                .then(annotations => res.status(200).json(annotations));
        });


});

/**
* Make new reply for a given annotation and emit socket io message
* @name POST/api/annotations/reply/:id
* @param id: id of parent annotation
* @param content: text content of annotation
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
*/
router.post('/reply/:id', (req, res) => {
    let username = ""
    Annotation.findByPk(req.params.id, { include: [{ association: 'Thread', include: [{ association: 'HeadAnnotation', attributes: ['id'] }, { association: 'SeenUsers' }] }] }).then((parent) =>
        Annotation.create({
            content: req.body.content,
            visibility: req.body.visibility,
            anonymity: req.body.anonymity,
            thread_id: parent.Thread.id,
            author_id: req.user.id,
            endorsed: req.body.endorsed,
            Tags: req.body.tags.map(tag_type => { return { tag_type_id: tag_type }; }),
        }, {
            include: [{ association: 'Tags' }]
        }).then((child) => {
            req.body.userTags.forEach(user_id => User.findByPk(user_id).then(user => child.addTaggedUser(user)));
            User.findByPk(req.user.id).then(user => {
                if (req.body.replyRequest) child.addReplyRequester(user);
                if (req.body.star) child.addStarrer(user);
                if (req.body.bookmark) child.addBookmarker(user);
                parent.Thread.setSeenUsers([user]);
                parent.Thread.setRepliedUsers([user]);
                username = user.username;
                const io = socketapi.io
                const urlHash = crypto.createHash('md5').update(req.body.url).digest('hex')
                const globalRoomId = `${urlHash}:${req.body.class}`
                const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))
                io.to(globalRoomId).emit('new_reply', { sourceUrl: req.body.url, classId: req.body.class, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...req.body.userTags], newAnnotationId: child.id })
                classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_reply', { sourceUrl: req.body.url, classId: req.body.class, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...req.body.userTags], newAnnotationId: child.id }))
               io.emit('new_reply', {filepath: req.body.url, class_id: req.body.class, user_id: req.user.id, seen_user:  parent.Thread.SeenUsers, parent:parent.Thread.id, reply_requests: req.body.replyRequest})

            });
            parent.addChild(child);
            res.status(200).json(child);
        })
    );
});

/**
* Make new reply for a given annotation and emit socket io message
* @name POST/api/annotations/media/reply/:id
* @param id: id of parent annotation
* @param content: text content of annotation
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
*/
router.post('/media/reply/:id', upload.single("file"), async (req, res) => {
    try {
        const filepath = `/media/${req.file.filename}`
        const body = JSON.parse(req.body.annotation)
        const parent = await Annotation.findByPk(req.params.id, { include: [{ association: 'Thread', include: [{ association: 'HeadAnnotation', attributes: ['id'] }] }] })
        const child = await Annotation.create({ content: body.content, visibility: body.visibility, anonymity: body.anonymity, thread_id: parent.Thread.id, author_id: req.user.id, Tags: body.tags.map(tag_type => { return { tag_type_id: tag_type }; }), }, { include: [{ association: 'Tags' }] })
        body.userTags.forEach(user_id => User.findByPk(user_id).then(user => child.addTaggedUser(user)));
        const user = await User.findByPk(req.user.id)
        if (body.replyRequest) child.addReplyRequester(user);
        if (body.star) child.addStarrer(user);
        if (body.bookmark) child.addBookmarker(user);
        parent.Thread.setSeenUsers([user]);
        parent.Thread.setRepliedUsers([user]);

        const annotationMedia = await AnnotationMedia.create({ type: body.type, filepath: filepath })
        await child.setMedia(annotationMedia)

        const childWithMedia = await Annotation.findByPk(child.id, { include: [{ association: 'Thread' }, { association: 'Media' }] })

        const io = socketapi.io
        const urlHash = crypto.createHash('md5').update(body.url).digest('hex')
        const globalRoomId = `${urlHash}:${body.class}`
        const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))
        io.to(globalRoomId).emit('new_reply', { sourceUrl: body.url, classId: body.class, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...body.userTags], newAnnotationId: child.id })
        classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_reply', { sourceUrl: body.url, classId: body.class, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...body.userTags], newAnnotationId: child.id }))

        parent.addChild(child);
        res.status(200).json(childWithMedia);
    } catch (error) {
        console.error('\n\nannotations/media/reply');
        console.error(error);
        res.status(500).json(error)
    }

});

/**
* Edit a given annotation
* @name GET/api/annotations/reply/:id
* @param id: id of parent annotation
* @param content: text content of annotation
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
*/
router.put('/annotation/:id', (req, res) => {
    Annotation.findByPk(req.params.id)
        .then(annotation =>
            annotation.update({
                content: req.body.content,
                visibility: req.body.visibility,
                anonymity: req.body.anonymity,
                endorsed: req.body.endorsed
            })
                .then(() => Tag.destroy({ where: { annotation_id: annotation.id } }))
                .then(() => {
                    if (req.body.userTags && req.body.userTags.length) {
                        Promise.all(req.body.userTags.map(user_id => User.findByPk(user_id)))
                            .then(users => annotation.setTaggedUsers(users));
                    }
                    if (req.body.tags && req.body.tags.length) {
                        Promise.all(req.body.tags.map(tag => Tag.create({ annotation_id: annotation.id, tag_type_id: tag })))
                            .then(tags => annotation.setTags(tags));
                    }
                    return User.findByPk(req.user.id).then(user => {
                        if (req.body.replyRequest) annotation.addReplyRequester(user);
                        else annotation.removeReplyRequester(user);
                    });
                })
                .then(() => res.sendStatus(200))
        );
});

/**
* Deletes a given annotation
* @name DELETE/api/annotations/annotation/:id
* @param id: id of annotation
*/
router.delete('/annotation/:id', (req, res) => {
    Annotation.findByPk(req.params.id, {
        include: [
            { association: 'Author', attributes: ['id'] },
            {association: 'ReplyRequesters'},
            { association: 'Thread', include: [{
                association: 'SeenUsers'},{
                association: 'Location', include: [{
                    association: 'Source',  attributes: ['filepath'], include: [{
                        association: 'Class', attributes: ['id'],
                    }]
                }]
            }]},
            { association: 'Parent', attributes: ['id'] }
        ]
    })
        .then(annotation => {
            annotation.destroy();
            if (!annotation.Parent) {
                annotation.Thread.destroy();
                annotation.Thread.Location.destroy();
            }
      
            var io = socketapi.io
            const class_id = annotation.Thread.Location.Source.Class.id
            const filepath = annotation.Thread.Location.Source.filepath
            const user_id = annotation.Author.id
            const seen_users = annotation.Thread.SeenUsers
            const parent = annotation.Parent
            const reply_requests = annotation.ReplyRequesters
            io.emit('delete_comment', {filepath:filepath, class_id: class_id, user_id: user_id, seen_user: seen_users, parent:parent, reply_requests: reply_requests})


        })
        .then(() => res.sendStatus(200))
        .catch((err) => res.sendStatus(400));
});

/**
* Sets seen for a given annotation and user
* @name POST/api/annotations/star/:id
* @param id: id of annotation
*/
router.post('/seen/:id', (req, res) => {
    Annotation.findByPk(req.params.id, { include: [{ association: 'Thread',  attributes: ['id'], include: [{
        association: 'Location', include: [{
            association: 'Source',  attributes: ['filepath'], include: [{
                association: 'Class', attributes: ['id'],
            }]
        }]
    }] }] }).then(annotation =>
        User.findByPk(req.user.id).then(user => {
            annotation.Thread.removeSeenUser(user).then(() => {
                annotation.Thread.addSeenUser(user)
            })
            const class_id = annotation.Thread.Location.Source.Class.id
            const filepath = annotation.Thread.Location.Source.filepath
            var io = socketapi.io
            // io.emit('read_thread', {filepath:filepath, class_id: class_id, user_id: req.user.id})
            io.emit('read_thread', {filepath:filepath, class_id: class_id, user_id: req.user.id, thread_id: annotation.Thread.id})
        }).then(() => res.sendStatus(200))
            .catch((err) => res.sendStatus(400))
    );
});

/**
* Toggles a star for a given annotation
* @name POST/api/annotations/star/:id
* @param id: id of annotation
*/
router.post('/star/:id', (req, res) => {
    Annotation.findByPk(req.params.id, { include: [{ association: 'Thread' }] }).then(annotation =>
        User.findByPk(req.user.id).then(user => {
            if (req.body.star) { annotation.addStarrer(user); }
            else { annotation.removeStarrer(user); }
            annotation.Thread.removeSeenUser(user).then(() => {
                annotation.Thread.addSeenUser(user)
            })
            annotation.Thread.removeRepliedUser(user).then(() => {
                annotation.Thread.addRepliedUser(user)
            })
        }).then(() => res.sendStatus(200))
            .catch((err) => res.sendStatus(400))
    );
});

/**
* Toggles a replyRequest for a given annotation
* @name POST/api/annotations/replyRequest/:id
* @param id: id of annotation
*/
router.post('/replyRequest/:id', (req, res) => {
    const add_request = req.body.replyRequest
    Annotation.findByPk(req.params.id,{include: [ {association: 'ReplyRequesters'}, { association: 'Author', attributes: ['id'] },{
            association: 'Thread', include: [{
                association: 'Location', include: [{
                    association: 'Source',  attributes: ['filepath'], include: [{
                        association: 'Class', attributes: ['id'],
                    }]
                }]
            }]
        }] }).then(annotation =>
        User.findByPk(req.user.id).then(user => {
            const class_id = annotation.Thread.Location.Source.Class.id
            const filepath = annotation.Thread.Location.Source.filepath
            const user_id = annotation.Author.id
            const reply_requesters = annotation.ReplyRequesters
            if (req.body.replyRequest) { annotation.addReplyRequester(user); }
            else { annotation.removeReplyRequester(user); }
            annotation.Thread.removeSeenUser(user).then(() => {
                annotation.Thread.addSeenUser(user)
            })
            annotation.Thread.removeRepliedUser(user).then(() => {
                annotation.Thread.addRepliedUser(user)
            })
            var io = socketapi.io
            io.emit('reply_request', {filepath:filepath, class_id: class_id, user_id: user_id, add_request: add_request, reply_requesters: reply_requesters})

        }).then(() => res.sendStatus(200))
            .catch((err) => res.sendStatus(400))
    );
});

/**
* Toggles a bookmark for a given annotation
* @name POST/api/annotations/bookmark/:id
* @param id: id of annotation
*/
router.post('/bookmark/:id', (req, res) => {
    Annotation.findByPk(req.params.id, { include: [{ association: 'Thread' }] }).then(annotation =>
        User.findByPk(req.user.id).then(user => {
            if (req.body.bookmark) { annotation.addBookmarker(user); }
            else { annotation.removeBookmarker(user); }
            annotation.Thread.removeSeenUser(user).then(() => {
                annotation.Thread.addSeenUser(user)
            })
            annotation.Thread.removeRepliedUser(user).then(() => {
                annotation.Thread.addRepliedUser(user)
            })
        }).then(() => res.sendStatus(200))
            .catch((err) => res.sendStatus(400))

    );
});


function simplifyUser(user, role) {
    const id = user.id;
    user = user.get({ plain: true });
    user.id = id;
    user.name = { first: user.first_name, last: user.last_name };
    user.role = role;
    return user;
}


module.exports = router;
