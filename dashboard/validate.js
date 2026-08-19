/**
 * Operations Dashboard — Load & Validate
 *
 * Phase 1 (spec §9 step 1): fetch sprint-plan.json cache-busted, then validate it
 * against spec §2 ("Rules the file must obey") and §7 ("Edge cases & validation").
 *
 * Public API
 *   OpsDashValidate.load(url)              → Promise<{ok, plan, report, index}>
 *   OpsDashValidate.validate(plan)         → report            (pure, no I/O)
 *   OpsDashValidate.buildIndex(plan)       → id lookup tables
 *   OpsDashValidate.resolveDeps(task, ix)  → prerequisite task ids (§4.2)
 *   OpsDashValidate.formatReport(report)   → human-readable string
 *
 * Contract: nothing fails silently. Every problem lands in report.errors with the
 * offending id and its path in the file. Callers MUST check `ok` before using the
 * plan — see §7 ("do not silently proceed").
 */
(function (root) {
  "use strict";

  var VALID_TYPES = ["work", "meeting", "approval"];
  var OWNER_BOTH = "Both";
  var SUPPORTED_SCHEMA = "1.0";

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * Owner resolution — THE single definition (D-107)
   *
   * Lives here, next to the validation that defines the field's legal
   * shape, so the rule and its only reader cannot drift apart. Every other
   * module reads owners through these two functions; the expression used to
   * be copied into engine.js, todos.js and thisweek.js, which is how the
   * same field came to mean two different things.
   *
   * Note what is NOT a parameter: `people`. The old resolver expanded the
   * literal "Both" to people.slice(), so the answer depended on who was in
   * the sprint — and changed, silently, the day a third person joined.
   * Owners now come only from the field itself.
   * ------------------------------------------------------------------ */

  /**
   * Every owner of a task, as an array.
   *
   * Accepts BOTH shapes the app passes around: a plan task (`owner`, a name
   * or an array of names) and an engine output entry (`owners`, already
   * resolved). One reader for both, so a caller cannot pick the wrong one.
   *
   * Returns a fresh array — callers sort and join it.
   */
  function ownersOf(task) {
    if (!task) return [];
    if (Array.isArray(task.owners)) return task.owners.slice(); // engine output
    var owner = task.owner;
    if (Array.isArray(owner)) return owner.slice();             // joint plan task
    if (owner === undefined || owner === null || owner === "") return [];
    return [owner];
  }

  /**
   * How a task's owners are written on screen: "Brent + Bernardo".
   *
   * The ONLY owner format in the app. A single owner renders exactly as it
   * always did, because a one-element join is the name itself.
   */
  function ownerLabel(task) {
    return ownersOf(task).join(" + ");
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function isNonEmptyString(v) {
    return typeof v === "string" && v.trim() !== "";
  }

  function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v);
  }

  /** True for a real calendar date written exactly as YYYY-MM-DD. */
  function isIsoDate(v) {
    if (!isNonEmptyString(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var parts = v.split("-");
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    var d = Number(parts[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var probe = new Date(Date.UTC(y, m - 1, d));
    return (
      probe.getUTCFullYear() === y &&
      probe.getUTCMonth() === m - 1 &&
      probe.getUTCDate() === d
    );
  }

  function describe(v) {
    if (typeof v === "string") return JSON.stringify(v);
    if (v === undefined) return "missing";
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (isPlainObject(v)) return "object";
    return String(v);
  }

  /* ------------------------------------------------------------------ *
   * Report
   * ------------------------------------------------------------------ */

  function newReport() {
    return {
      ok: false,
      errors: [],
      warnings: [],
      stats: { rocks: 0, projects: 0, milestones: 0, tasks: 0, deferredTasks: 0 }
    };
  }

  function addError(report, code, id, path, message) {
    report.errors.push({ code: code, id: id || null, path: path || null, message: message });
  }

  function addWarning(report, code, id, path, message) {
    report.warnings.push({ code: code, id: id || null, path: path || null, message: message });
  }

  /* ------------------------------------------------------------------ *
   * Index — every structural id in the sprint, plus duplicate detection
   * ------------------------------------------------------------------ */

  /**
   * Walks the plan and indexes rocks, projects, milestones and tasks by id.
   * Duplicates are recorded rather than overwriting: the FIRST occurrence wins
   * in the lookup tables, and every later one is reported (§2: ids unique).
   */
  function buildIndex(plan) {
    var index = {
      rocks: {},
      projects: {},
      milestones: {},
      tasks: {},
      taskOrder: [],
      milestoneOrder: [],
      milestoneOfTask: {},
      tasksOfMilestone: {},
      paths: {},
      kinds: {},
      duplicates: []
    };

    function claim(kind, id, path) {
      if (!isNonEmptyString(id)) return false;
      if (Object.prototype.hasOwnProperty.call(index.kinds, id)) {
        index.duplicates.push({
          id: id,
          kind: kind,
          path: path,
          firstKind: index.kinds[id],
          firstPath: index.paths[id]
        });
        return false;
      }
      index.kinds[id] = kind;
      index.paths[id] = path;
      return true;
    }

    var rocks = Array.isArray(plan && plan.rocks) ? plan.rocks : [];

    for (var ri = 0; ri < rocks.length; ri++) {
      var rock = rocks[ri];
      var rockPath = "rocks[" + ri + "]";
      if (!isPlainObject(rock)) continue;
      if (claim("rock", rock.id, rockPath)) index.rocks[rock.id] = rock;

      var projects = Array.isArray(rock.projects) ? rock.projects : [];
      for (var pi = 0; pi < projects.length; pi++) {
        var project = projects[pi];
        var projectPath = rockPath + ".projects[" + pi + "]";
        if (!isPlainObject(project)) continue;
        if (claim("project", project.id, projectPath)) index.projects[project.id] = project;

        var milestones = Array.isArray(project.milestones) ? project.milestones : [];
        for (var mi = 0; mi < milestones.length; mi++) {
          var milestone = milestones[mi];
          var milestonePath = projectPath + ".milestones[" + mi + "]";
          if (!isPlainObject(milestone)) continue;
          if (claim("milestone", milestone.id, milestonePath)) {
            index.milestones[milestone.id] = milestone;
            index.milestoneOrder.push(milestone.id);
            index.tasksOfMilestone[milestone.id] = [];
          }

          var tasks = Array.isArray(milestone.tasks) ? milestone.tasks : [];
          for (var ti = 0; ti < tasks.length; ti++) {
            var task = tasks[ti];
            var taskPath = milestonePath + ".tasks[" + ti + "]";
            if (!isPlainObject(task)) continue;
            if (claim("task", task.id, taskPath)) {
              index.tasks[task.id] = task;
              index.taskOrder.push(task.id);
              index.milestoneOfTask[task.id] = milestone.id;
              if (index.tasksOfMilestone[milestone.id]) {
                index.tasksOfMilestone[milestone.id].push(task.id);
              }
            }
          }
        }
      }
    }

    return index;
  }

  /* ------------------------------------------------------------------ *
   * Dependency resolution (§4.2)
   * ------------------------------------------------------------------ */

  function declaredDeps(entity) {
    var out = [];
    var lists = [entity && entity.dependsOn, entity && entity.crossDependsOn];
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i];
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) out.push(list[j]);
    }
    return out;
  }

  /**
   * Resolves a task's declared dependencies to concrete prerequisite task ids.
   * A task id resolves to itself; a milestone id resolves to ALL tasks of that
   * milestone (§4.2). Anything else is returned as unresolved.
   */
  function resolveDeps(task, index) {
    var out = { taskIds: [], unresolved: [], selfMilestone: [], emptyMilestone: [] };
    var seen = {};
    var declared = declaredDeps(task);
    var ownMilestone = index.milestoneOfTask[task && task.id];

    for (var i = 0; i < declared.length; i++) {
      var ref = declared[i];
      if (!isNonEmptyString(ref)) {
        out.unresolved.push(ref);
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(index.tasks, ref)) {
        if (!seen[ref]) { seen[ref] = true; out.taskIds.push(ref); }
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(index.milestones, ref)) {
        if (ref === ownMilestone) out.selfMilestone.push(ref);
        var members = index.tasksOfMilestone[ref] || [];
        if (!members.length) out.emptyMilestone.push(ref);
        for (var k = 0; k < members.length; k++) {
          var memberId = members[k];
          if (!seen[memberId]) { seen[memberId] = true; out.taskIds.push(memberId); }
        }
        continue;
      }

      out.unresolved.push(ref);
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Cycle detection — iterative DFS that recovers the offending path
   * ------------------------------------------------------------------ */

  /**
   * @param nodes  ordered array of node ids
   * @param edgesOf function(id) → array of prerequisite ids
   * @returns array of cycles, each an array of ids forming the loop
   */
  function findCycles(nodes, edgesOf) {
    var WHITE = 0, GRAY = 1, BLACK = 2;
    var color = {};
    var cycles = [];
    var reported = {};
    var i;

    for (i = 0; i < nodes.length; i++) color[nodes[i]] = WHITE;

    for (i = 0; i < nodes.length; i++) {
      if (color[nodes[i]] !== WHITE) continue;

      var stack = [{ id: nodes[i], edges: edgesOf(nodes[i]), cursor: 0 }];
      var path = [nodes[i]];
      var onPath = {};
      onPath[nodes[i]] = true;
      color[nodes[i]] = GRAY;

      while (stack.length) {
        var frame = stack[stack.length - 1];

        if (frame.cursor >= frame.edges.length) {
          color[frame.id] = BLACK;
          onPath[frame.id] = false;
          path.pop();
          stack.pop();
          continue;
        }

        var next = frame.edges[frame.cursor++];
        if (color[next] === undefined) continue; // not a known node; reported elsewhere

        if (onPath[next]) {
          var from = path.indexOf(next);
          var loop = path.slice(from < 0 ? 0 : from).concat([next]);
          var key = loop.slice().sort().join("|");
          if (!reported[key]) { reported[key] = true; cycles.push(loop); }
          continue;
        }

        if (color[next] === WHITE) {
          color[next] = GRAY;
          onPath[next] = true;
          path.push(next);
          stack.push({ id: next, edges: edgesOf(next), cursor: 0 });
        }
      }
    }

    return cycles;
  }

  /* ------------------------------------------------------------------ *
   * validate(plan)
   * ------------------------------------------------------------------ */

  function validate(plan) {
    var report = newReport();
    var i;

    if (!isPlainObject(plan)) {
      addError(report, "SHAPE", null, "(root)",
        "sprint-plan must be a JSON object, got " + describe(plan) + ".");
      return report;
    }

    /* ---- schemaVersion (spec §2) ---- */
    if (plan.schemaVersion === undefined) {
      addWarning(report, "SCHEMA_VERSION_MISSING", null, "schemaVersion",
        'No schemaVersion; assuming "' + SUPPORTED_SCHEMA + '".');
    } else if (plan.schemaVersion !== SUPPORTED_SCHEMA) {
      addWarning(report, "SCHEMA_VERSION_UNKNOWN", null, "schemaVersion",
        "schemaVersion is " + describe(plan.schemaVersion) + '; this build targets "' +
        SUPPORTED_SCHEMA + '". Validating anyway.');
    }

    /* ---- sprint block ---- */
    var sprint = plan.sprint;
    if (!isPlainObject(sprint)) {
      addError(report, "SPRINT_MISSING", null, "sprint",
        "sprint block is required, got " + describe(sprint) + ".");
    } else {
      if (!isNonEmptyString(sprint.id)) {
        addError(report, "SPRINT_ID", null, "sprint.id",
          "sprint.id is required, got " + describe(sprint.id) + ".");
      }
      if (!isIsoDate(sprint.start)) {
        addError(report, "SPRINT_DATE", sprint.id, "sprint.start",
          "sprint.start must be an ISO date (YYYY-MM-DD), got " + describe(sprint.start) + ".");
      }
      if (!isIsoDate(sprint.end)) {
        addError(report, "SPRINT_DATE", sprint.id, "sprint.end",
          "sprint.end must be an ISO date (YYYY-MM-DD), got " + describe(sprint.end) + ".");
      }
      if (isIsoDate(sprint.start) && isIsoDate(sprint.end) && sprint.end < sprint.start) {
        addError(report, "SPRINT_RANGE", sprint.id, "sprint.end",
          "sprint.end (" + sprint.end + ") is before sprint.start (" + sprint.start + ").");
      }
      if (sprint.goLive !== undefined && !isIsoDate(sprint.goLive)) {
        addError(report, "SPRINT_DATE", sprint.id, "sprint.goLive",
          "sprint.goLive must be an ISO date (YYYY-MM-DD), got " + describe(sprint.goLive) + ".");
      }
    }

    /* ---- people (owner validation depends on this) ---- */
    var peopleSet = {};
    var peopleOk = false;
    if (!Array.isArray(plan.people) || !plan.people.length) {
      addError(report, "PEOPLE_MISSING", null, "people",
        "people must be a non-empty array of names, got " + describe(plan.people) + ".");
    } else {
      peopleOk = true;
      for (i = 0; i < plan.people.length; i++) {
        var person = plan.people[i];
        if (!isNonEmptyString(person)) {
          addError(report, "PEOPLE_ENTRY", null, "people[" + i + "]",
            "people entries must be non-empty strings, got " + describe(person) + ".");
          peopleOk = false;
          continue;
        }
        if (person === OWNER_BOTH) {
          addError(report, "PEOPLE_RESERVED", null, "people[" + i + "]",
            '"' + OWNER_BOTH + '" is reserved as the joint-owner marker and cannot be a person name.');
          peopleOk = false;
          continue;
        }
        peopleSet[person] = true;
      }
    }

    /** No "Both" in the hint anywhere in the file, on any owner field — the
     *  point of D-107 pass 2: a message that names the removed word is an
     *  invitation to type it. Tells the reader to list names instead. */
    function ownerHint() {
      var names = Object.keys(peopleSet);
      return "expected one of [" + names.join(", ") +
        "], or a list of them for joint work";
    }

    /**
     * THE single owner rule (D-107, both passes): one name from people[], or
     * an array of at least one name, all in people[], no repeats. Order is
     * meaningless. Used for task.owner, project.owner and each element of
     * rock.owners alike — one function, three call sites, so the rule can
     * never read differently in one place than another.
     *
     * Four distinct blocking codes, because the fixes are different: the
     * literal "Both" needs rewriting as a list, an empty list needs a name,
     * a repeat needs deleting, and an unknown name needs correcting. Folding
     * "Both" into UNKNOWN_OWNER would tell someone their spelling was wrong
     * when the word itself is gone.
     *
     * @param id        the owning object's id, for the error message and report row
     * @param owner     the value to check — a name, a list, or garbage
     * @param fieldPath the JSON path TO THE OWNER FIELD ITSELF (already ends
     *                  in ".owner" or ".owners[i]" — this function appends
     *                  "[i]" only for a list's own elements)
     * @param noun      "task" | "project" | "rock" — only for wording
     */
    function checkOwner(id, owner, fieldPath, noun) {
      if (owner === OWNER_BOTH) {
        addError(report, "OWNER_BOTH_REMOVED", id, fieldPath,
          'The ' + noun + ' ' + id + ' has owner "' + OWNER_BOTH + '", which is no ' +
          'longer part of the schema. List the owners instead, for example ' +
          '["Brent", "Bernardo"]. The word used to mean "everyone in people", so it ' +
          'changed meaning by itself whenever someone joined the sprint.');
        return;
      }

      if (Array.isArray(owner)) {
        if (!owner.length) {
          addError(report, "OWNER_LIST_EMPTY", id, fieldPath,
            "The " + noun + " " + id + " has an empty owner list; it needs at least one owner.");
          return;
        }
        var seen = {};
        for (var i = 0; i < owner.length; i++) {
          var name = owner[i];
          var slot = fieldPath + "[" + i + "]";
          if (typeof name !== "string" || peopleSet[name] !== true) {
            addError(report, "UNKNOWN_OWNER", id, slot,
              "Unknown owner " + describe(name) + " on " + noun + " " + id +
              " (" + ownerHint() + ").");
            continue;
          }
          if (seen[name] === true) {
            addError(report, "OWNER_LIST_DUPLICATE", id, slot,
              "The " + noun + " " + id + " lists owner " + describe(name) +
              " more than once; each owner appears at most once.");
            continue;
          }
          seen[name] = true;
        }
        return;
      }

      if (typeof owner !== "string" || peopleSet[owner] !== true) {
        addError(report, "UNKNOWN_OWNER", id, fieldPath,
          "Unknown owner " + describe(owner) + " on " + noun + " " + id +
          " (" + ownerHint() + ").");
      }
    }

    /* ---- rocks present ---- */
    if (!Array.isArray(plan.rocks) || !plan.rocks.length) {
      addError(report, "ROCKS_MISSING", null, "rocks",
        "rocks must be a non-empty array, got " + describe(plan.rocks) + ".");
      return report;
    }

    /* ---- index + duplicate ids (§2: every id unique) ---- */
    var index = buildIndex(plan);
    for (i = 0; i < index.duplicates.length; i++) {
      var dup = index.duplicates[i];
      addError(report, "DUPLICATE_ID", dup.id, dup.path,
        'Duplicate id "' + dup.id + '": ' + dup.kind + " at " + dup.path +
        " collides with " + dup.firstKind + " at " + dup.firstPath + ".");
    }

    report.stats.rocks = Object.keys(index.rocks).length;
    report.stats.projects = Object.keys(index.projects).length;
    report.stats.milestones = Object.keys(index.milestones).length;
    report.stats.tasks = index.taskOrder.length;

    /* ---- walk the tree for per-entity rules ---- */
    for (var ri = 0; ri < plan.rocks.length; ri++) {
      var rock = plan.rocks[ri];
      var rockPath = "rocks[" + ri + "]";

      if (!isPlainObject(rock)) {
        addError(report, "ROCK_SHAPE", null, rockPath,
          "rock must be an object, got " + describe(rock) + ".");
        continue;
      }
      if (!isNonEmptyString(rock.id)) {
        addError(report, "ROCK_ID", null, rockPath + ".id",
          "rock.id is required, got " + describe(rock.id) + ".");
      }
      if (rock.owners !== undefined) {
        if (!Array.isArray(rock.owners)) {
          addError(report, "ROCK_OWNERS", rock.id, rockPath + ".owners",
            "rock.owners must be an array, got " + describe(rock.owners) + ".");
        } else if (peopleOk) {
          // Each ELEMENT is one person's name, not itself a joint-owner field —
          // checkOwner still applies per element since a single string is exactly
          // the scalar case it already handles (D-107 pass 2).
          for (i = 0; i < rock.owners.length; i++) {
            checkOwner(rock.id, rock.owners[i], rockPath + ".owners[" + i + "]", "rock");
          }
        }
      }

      var projects = Array.isArray(rock.projects) ? rock.projects : [];
      if (!projects.length) {
        addWarning(report, "ROCK_EMPTY", rock.id, rockPath + ".projects",
          "Rock " + rock.id + " has no projects.");
      }

      for (var pi = 0; pi < projects.length; pi++) {
        var project = projects[pi];
        var projectPath = rockPath + ".projects[" + pi + "]";

        if (!isPlainObject(project)) {
          addError(report, "PROJECT_SHAPE", null, projectPath,
            "project must be an object, got " + describe(project) + ".");
          continue;
        }
        if (!isNonEmptyString(project.id)) {
          addError(report, "PROJECT_ID", null, projectPath + ".id",
            "project.id is required, got " + describe(project.id) + ".");
        }
        if (project.owner !== undefined && peopleOk) {
          checkOwner(project.id, project.owner, projectPath + ".owner", "project");
        }

        var milestones = Array.isArray(project.milestones) ? project.milestones : [];
        if (!milestones.length) {
          addWarning(report, "PROJECT_EMPTY", project.id, projectPath + ".milestones",
            "Project " + project.id + " has no milestones.");
        }

        for (var mi = 0; mi < milestones.length; mi++) {
          var milestone = milestones[mi];
          var milestonePath = projectPath + ".milestones[" + mi + "]";

          if (!isPlainObject(milestone)) {
            addError(report, "MILESTONE_SHAPE", null, milestonePath,
              "milestone must be an object, got " + describe(milestone) + ".");
            continue;
          }
          if (!isNonEmptyString(milestone.id)) {
            addError(report, "MILESTONE_ID", null, milestonePath + ".id",
              "milestone.id is required, got " + describe(milestone.id) + ".");
          }

          /* deadline is OPTIONAL on a milestone (§2, D-087): a hard external
             constraint (a launch, a client commitment), never an estimate,
             and never an input to the engine (D-087b) — §5.3 only compares it
             against the computed finish for display. Same isIsoDate() used
             for sprint.start/end/task.hardDeadline, so the severity matches
             theirs exactly rather than a looser ad-hoc check. Named distinctly
             from task-level hardDeadline (§4.4's priority tiebreak) — the two
             fields look similar but do opposite things, so their codes must
             never collide. */
          if (milestone.deadline !== undefined) {
            if (!isIsoDate(milestone.deadline)) {
              addError(report, "BAD_MILESTONE_DEADLINE", milestone.id, milestonePath + ".deadline",
                "deadline on milestone " + milestone.id + " must be an ISO date (YYYY-MM-DD), got " +
                describe(milestone.deadline) + ".");
            } else if (isPlainObject(sprint) && isIsoDate(sprint.start) && isIsoDate(sprint.end) &&
              (milestone.deadline < sprint.start || milestone.deadline > sprint.end)) {
              addWarning(report, "MILESTONE_DEADLINE_OUTSIDE_SPRINT", milestone.id, milestonePath + ".deadline",
                "deadline on milestone " + milestone.id + " (" + milestone.deadline + ") falls outside " +
                "the sprint window (" + sprint.start + " to " + sprint.end + "). Unusual but legitimate (§7).");
            }
          }

          var tasks = Array.isArray(milestone.tasks) ? milestone.tasks : [];
          if (!tasks.length) {
            addWarning(report, "MILESTONE_EMPTY", milestone.id, milestonePath + ".tasks",
              "Milestone " + milestone.id + " has no tasks; anything depending on it is " +
              "satisfied vacuously.");
          }

          for (var ti = 0; ti < tasks.length; ti++) {
            var task = tasks[ti];
            var taskPath = milestonePath + ".tasks[" + ti + "]";

            if (!isPlainObject(task)) {
              addError(report, "TASK_SHAPE", null, taskPath,
                "task must be an object, got " + describe(task) + ".");
              continue;
            }
            if (!isNonEmptyString(task.id)) {
              addError(report, "TASK_ID", null, taskPath + ".id",
                "task.id is required, got " + describe(task.id) + ".");
              continue;
            }
            if (!isNonEmptyString(task.desc)) {
              addWarning(report, "TASK_DESC", task.id, taskPath + ".desc",
                "Task " + task.id + " has no description.");
            }

            /* owner = a name from people, or an explicit list of them (§2, D-107) */
            if (peopleOk) checkOwner(task.id, task.owner, taskPath + ".owner", "task");

            /* type ∈ {work, meeting, approval} (§2) */
            if (VALID_TYPES.indexOf(task.type) === -1) {
              addError(report, "UNKNOWN_TYPE", task.id, taskPath + ".type",
                "Unknown type " + describe(task.type) + " on task " + task.id +
                " (expected one of [" + VALID_TYPES.join(", ") + "]).");
            }

            /* workDays ≥ 0, waitDays ≥ 0, fractions allowed (§2) */
            var durations = [["workDays", task.workDays], ["waitDays", task.waitDays]];
            for (i = 0; i < durations.length; i++) {
              var field = durations[i][0];
              var value = durations[i][1];
              if (!isFiniteNumber(value)) {
                addError(report, "BAD_DURATION", task.id, taskPath + "." + field,
                  field + " on task " + task.id + " must be a finite number, got " +
                  describe(value) + ".");
              } else if (value < 0) {
                addError(report, "NEGATIVE_DURATION", task.id, taskPath + "." + field,
                  field + " on task " + task.id + " must be ≥ 0, got " + value + ".");
              }
            }

            /* hardDeadline is an optional ISO date (§1 task table) */
            if (task.hardDeadline !== undefined && !isIsoDate(task.hardDeadline)) {
              addError(report, "BAD_DEADLINE", task.id, taskPath + ".hardDeadline",
                "hardDeadline on task " + task.id + " must be an ISO date (YYYY-MM-DD), got " +
                describe(task.hardDeadline) + ".");
            }

            /* status MUST NOT appear; if present it is ignored (§2) */
            if (Object.prototype.hasOwnProperty.call(task, "status")) {
              addWarning(report, "STATUS_IN_PLAN", task.id, taskPath + ".status",
                "Task " + task.id + ' carries a "status" field (' + describe(task.status) +
                "). Ignored — status is owned by the Events sheet, not this file.");
            }

            if (task.deferred === true) report.stats.deferredTasks++;

            /* dependency lists must be arrays of ids */
            var depLists = [["dependsOn", task.dependsOn], ["crossDependsOn", task.crossDependsOn]];
            for (i = 0; i < depLists.length; i++) {
              var listName = depLists[i][0];
              var listValue = depLists[i][1];
              if (listValue !== undefined && !Array.isArray(listValue)) {
                addError(report, "BAD_DEP_LIST", task.id, taskPath + "." + listName,
                  listName + " on task " + task.id + " must be an array, got " +
                  describe(listValue) + ".");
              }
            }
          }

          /* milestone-level dependsOn must also resolve (§2: "any dependsOn") */
          if (milestone.dependsOn !== undefined && !Array.isArray(milestone.dependsOn)) {
            addError(report, "BAD_DEP_LIST", milestone.id, milestonePath + ".dependsOn",
              "dependsOn on milestone " + milestone.id + " must be an array, got " +
              describe(milestone.dependsOn) + ".");
          }
        }
      }
    }

    /* ---- dependency references resolve (§2, §7) ---- */
    var taskPrereqs = {};

    for (i = 0; i < index.taskOrder.length; i++) {
      var tid = index.taskOrder[i];
      var t = index.tasks[tid];
      var resolved = resolveDeps(t, index);
      taskPrereqs[tid] = resolved.taskIds;

      var j;
      for (j = 0; j < resolved.unresolved.length; j++) {
        addError(report, "UNRESOLVED_DEP", tid, index.paths[tid],
          "Task " + tid + " depends on " + describe(resolved.unresolved[j]) +
          ", which is not a task id or milestone id in this sprint.");
      }
      for (j = 0; j < resolved.selfMilestone.length; j++) {
        addError(report, "SELF_MILESTONE_DEP", tid, index.paths[tid],
          "Task " + tid + ' depends on its own milestone "' + resolved.selfMilestone[j] +
          '", which requires the task to finish before itself.');
      }
      for (j = 0; j < resolved.emptyMilestone.length; j++) {
        addWarning(report, "EMPTY_MILESTONE_DEP", tid, index.paths[tid],
          "Task " + tid + ' depends on milestone "' + resolved.emptyMilestone[j] +
          '", which has no tasks — the dependency is satisfied vacuously.');
      }
      if (resolved.taskIds.indexOf(tid) !== -1 && !resolved.selfMilestone.length) {
        addError(report, "SELF_DEP", tid, index.paths[tid],
          "Task " + tid + " depends on itself.");
      }
    }

    /* milestone-level declarative dependencies */
    var milestonePrereqs = {};
    for (i = 0; i < index.milestoneOrder.length; i++) {
      var mid = index.milestoneOrder[i];
      var ms = index.milestones[mid];
      var declared = Array.isArray(ms.dependsOn) ? ms.dependsOn : [];
      var edges = [];

      for (var d = 0; d < declared.length; d++) {
        var ref = declared[d];
        if (!isNonEmptyString(ref)) {
          addError(report, "UNRESOLVED_DEP", mid, index.paths[mid],
            "Milestone " + mid + " depends on " + describe(ref) +
            ", which is not a valid id.");
          continue;
        }
        if (ref === mid) {
          addError(report, "SELF_DEP", mid, index.paths[mid],
            "Milestone " + mid + " depends on itself.");
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(index.milestones, ref)) {
          edges.push(ref);
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(index.tasks, ref)) {
          // A milestone gated by a single task is legal (§2 allows task or milestone ids).
          continue;
        }
        addError(report, "UNRESOLVED_DEP", mid, index.paths[mid],
          "Milestone " + mid + " depends on " + describe(ref) +
          ", which is not a task id or milestone id in this sprint.");
      }

      milestonePrereqs[mid] = edges;
    }

    /* ---- no dependency cycles (§2, §4.2, §7) ---- */
    var taskCycles = findCycles(index.taskOrder, function (id) {
      return taskPrereqs[id] || [];
    });
    for (i = 0; i < taskCycles.length; i++) {
      addError(report, "DEPENDENCY_CYCLE", taskCycles[i][0], null,
        "Dependency cycle between tasks: " + taskCycles[i].join(" → ") + ".");
    }

    var milestoneCycles = findCycles(index.milestoneOrder, function (id) {
      return milestonePrereqs[id] || [];
    });
    for (i = 0; i < milestoneCycles.length; i++) {
      addError(report, "DEPENDENCY_CYCLE", milestoneCycles[i][0], null,
        "Dependency cycle between milestones: " + milestoneCycles[i].join(" → ") + ".");
    }

    report.ok = report.errors.length === 0;
    report.index = index;
    return report;
  }

  /* ------------------------------------------------------------------ *
   * Reporting
   * ------------------------------------------------------------------ */

  function formatLine(entry) {
    var where = entry.path ? " [" + entry.path + "]" : "";
    return "  · " + entry.code + where + ": " + entry.message;
  }

  function formatReport(report) {
    var lines = [];
    var i;

    if (report.errors.length) {
      lines.push("sprint-plan.json is INVALID — " + report.errors.length + " error(s):");
      for (i = 0; i < report.errors.length; i++) lines.push(formatLine(report.errors[i]));
    } else {
      lines.push(
        "sprint-plan.json validated clean: " +
        report.stats.rocks + " rock(s), " +
        report.stats.projects + " project(s), " +
        report.stats.milestones + " milestone(s), " +
        report.stats.tasks + " task(s)" +
        (report.stats.deferredTasks ? " (" + report.stats.deferredTasks + " deferred)" : "") + "."
      );
    }

    if (report.warnings.length) {
      lines.push(report.warnings.length + " warning(s):");
      for (i = 0; i < report.warnings.length; i++) lines.push(formatLine(report.warnings[i]));
    }

    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Fetch (§3 read path, §10 raw URL pattern)
   * ------------------------------------------------------------------ */

  /** Appends ?nocache=<ts> (or &nocache=) — the raw CDN serves stale copies (§3). */
  function cacheBust(url, stamp) {
    var ts = stamp === undefined ? new Date().getTime() : stamp;
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "nocache=" + ts;
  }

  function planUrl() {
    var cfg = root.OpsDashConfig;
    return (cfg && cfg.SPRINT_PLAN_URL) || null;
  }

  /**
   * Fetches the plan, parses it, validates it.
   * Resolves with {ok, plan, report, index}; rejects only when the file could not
   * be fetched or parsed at all. Callers MUST check `ok` (§7).
   */
  function load(url) {
    var target = url || planUrl();
    if (!target) {
      return Promise.reject(new Error(
        "No sprint-plan URL: pass one to OpsDashValidate.load() or set OpsDashConfig.SPRINT_PLAN_URL."
      ));
    }

    return fetch(cacheBust(target), { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error(
            "Could not fetch sprint-plan.json (HTTP " + response.status + " " +
            response.statusText + ") from " + target
          );
        }
        return response.text();
      })
      .then(function (text) {
        var plan;
        try {
          plan = JSON.parse(text);
        } catch (err) {
          throw new Error("sprint-plan.json is not valid JSON: " + err.message);
        }
        var report = validate(plan);
        return { ok: report.ok, plan: plan, report: report, index: report.index };
      });
  }

  root.OpsDashValidate = {
    load: load,
    validate: validate,
    buildIndex: buildIndex,
    resolveDeps: resolveDeps,
    findCycles: findCycles,
    formatReport: formatReport,
    cacheBust: cacheBust,
    /* The one owner resolver and the one owner format (D-107). */
    ownersOf: ownersOf,
    ownerLabel: ownerLabel,
    VALID_TYPES: VALID_TYPES,
    OWNER_BOTH: OWNER_BOTH
  };
})(typeof window !== "undefined" ? window : this);
